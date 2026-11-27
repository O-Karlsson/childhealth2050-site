// prospect-chart.js — "will this location halve the gap by 2050?"
//
// ONE chart, two row semantics (see ADR-009):
//   mode "outcomes"  rows are the five indicators for one location
//   mode "locations" rows are the selected locations for one indicator
//
// Plus `prospectGrid`, either of those drawn as small multiples in one <svg> — a panel
// per location holding the five indicators, or a panel per indicator holding the selected
// locations. It shares everything but the layout; see its own header.
//
// Marks, either way: a dot at the latest value, an arrow running from it to where
// the recent trend lands in 2050, and a track line carrying on to the goal. The
// arrow points RIGHT when the trend is closing the gap and LEFT when it is opening
// it, so direction of travel is readable without consulting the colour.
//
// Geometry. Every row runs from a starting value (left) to the goalpost (right). A
// value's position on that line IS the fraction of the gap closed, in both
// directions — mortality and the low-maths share fall toward zero, height rises toward
// a goalpost built from its own level, and the arithmetic is identical. So one number
// places the marker, the bands and the colour. See data-processing/README.md.
//
// Colour. Where the background BANDS can be drawn — a per-row scale, so "a quarter of
// the gap" is the same place on every line — they carry status, and the arrows are free
// to carry identity instead: ink for a single line, and validated hues when more than
// one sex or trend window is on screen. Where the bands cannot be drawn (a shared value
// scale, where each row's gap is a different size) the arrows carry status and identity
// falls back to a text key. Sex and trend window each get their own line, so an arrow
// never has to share.

// Panels. In "locations" mode the rows can be split into stacked groups — today by
// tercile of under-20 mortality — WITHOUT the figure becoming several figures. The
// scale, the bands, the axis and the legend are computed across every row exactly as
// they are unpanelled; all that changes is that the rows are reordered into groups and
// each group gets a heading. That is the point: panels are for reading, not for
// rescaling, and a per-panel axis would quietly make the groups incomparable.
//
// Two things here are easy to break by accident:
//
//   1. The chart lays itself out from `host.clientWidth`, and switches to a stacked
//      "compact" layout below a threshold. Lowering the .chart-host cap in site.css
//      without also lowering that threshold silently puts every desktop render into the
//      mobile design. They are set 180px apart on purpose.
//   2. The axis block height is measured from its contents (rule, ticks, tick labels,
//      title), not chosen. Trimming it clips the title.

import { num, fullName } from "./format.js";
import { optionsPanel } from "./figure-options.js";

const NS = "http://www.w3.org/2000/svg";

// What each rendered <svg> was drawn from. A WeakMap rather than a property on the node,
// so it cannot be serialized into the file by accident and cannot keep a replaced chart
// alive. `exportSvg` is the only reader: it needs the config to rebuild the legend, which
// lives in HTML on the page and therefore does not travel with a download.
const CHART_CFG = new WeakMap();

// Fixed status palette — never themed, never reused for a series.
const STATUS = {
  good:     { fill: "#0ca30c", label: "On track",  hint: "closes over half the distance" },
  warning:  { fill: "#fab219", label: "Partial",   hint: "closes a quarter to a half" },
  critical: { fill: "#d03b3b", label: "Off track", hint: "closes under a quarter" },
};

// Series identity. Ink first, so one line stays black and colour only ever appears when
// there is something to tell apart. The three hues are the dataviz categorical slots
// 1–3, checked for colour-vision separation against both surfaces — a fourth hue that
// clears the same bar in BOTH themes and stays clear of the status reds/ambers/greens
// does not exist in the ramp set, so past four lines colour is dropped for text.
const SERIES = [
  "var(--chart-mark)", "var(--series-1)", "var(--series-2)", "var(--series-3)",
];

// How rows may be grouped. The order is the order the panels stack in — worst first,
// which is the order the paper reads them in and matches the axis running left to right
// from off track to on track. "none" is last and is not a tercile: it holds locations
// with no under-20 mortality estimate at all (Hong Kong, Macao, Taiwan and six small
// territories are absent from UN IGME), which have to go somewhere and must not be
// quietly dropped from a figure they have data for.
const PANELS = {
  mortTercile: {
    order: ["high", "medium", "low", "none"],
    label: {
      high: "High under-20 mortality",
      medium: "Medium under-20 mortality",
      low: "Low under-20 mortality",
      none: "No under-20 mortality estimate",
    },
  },
};

const SEX_KEY = { 1: "Male", 2: "Female", 3: "Both" };
const SEX_LONG = { 1: "Male", 2: "Female", 3: "Both sexes" };
const WINDOW = { t10: "10-yr", t5: "5-yr", t5_10: "5–10 yr ago", t10_15: "10–15 yr ago" };
const WINDOW_SHORT = { t10: "10y", t5: "5y", t5_10: "5–10y", t10_15: "10–15y" };

const windowLabel = (w) => WINDOW[w] ?? w;
const shortWindow = (w) => WINDOW_SHORT[w] ?? w;

// The lines a row will hold, in the order buildRows emits them. Empty when there is only
// one, since then nothing needs naming. The chart and its legend both read from here, so
// a colour and its label can never drift apart.
function seriesKeysOf({ sexes, trends }) {
  if (sexes.length <= 1 && trends.length <= 1) return [];
  const out = [];
  for (const sx of sexes) {
    for (const w of trends) {
      out.push([sexes.length > 1 ? SEX_KEY[sx] : "", trends.length > 1 ? shortWindow(w) : ""]
        .filter(Boolean).join(" "));
    }
  }
  return out;
}

function el(tag, attrs = {}, text) {
  const n = document.createElementNS(NS, tag);
  for (const [k, v] of Object.entries(attrs)) if (v != null) n.setAttribute(k, v);
  if (text != null) n.textContent = text;
  return n;
}

function statusOf(pct, bands) {
  if (pct == null || !Number.isFinite(pct)) return null;
  if (pct >= bands[1]) return "good";
  if (pct >= bands[0]) return "warning";
  return "critical";
}

// Round values covering a range, for an axis measured in the outcome's own units. Even
// steps landing on 0 / 25 / 50 / 75 / 100 per cent of the pixel range would be exact but
// unreadable — "39, 29, 20, 9.8, 0" is a scale nobody can hold in their head.
//
// A step is refused when a tick it lands on would PRINT as a different number. `num` shows
// whole numbers from 10 up, so a 2.5 step across 159-170 cm put a tick at 162.5 and labelled
// it "163". The next coarser step is taken instead.
const printsExactly = (v) => {
  const a = Math.abs(v);
  const d = a >= 10 ? 0 : a >= 1 ? 1 : 2;
  return Math.abs(v - Number(v.toFixed(d))) < 1e-9;
};

export function niceTicks(lo, hi, target = 5) {
  const [a, b] = lo < hi ? [lo, hi] : [hi, lo];
  if (!(b > a)) return [a];
  const mag = 10 ** Math.floor(Math.log10((b - a) / target));
  let out = [];
  for (const m of [1, 2, 2.5, 5, 10, 20]) {
    const step = m * mag;
    if (step < (b - a) / target) continue;
    out = [];
    for (let v = Math.ceil(a / step) * step; v <= b + step * 1e-9; v += step) {
      out.push(Math.round(v / step) * step);
    }
    if (out.every(printsExactly)) return out;
  }
  return out;
}

// An arrowhead whose TIP sits exactly on the value, opening back toward the dot, so
// the connector line and the head read as a single arrow.
function arrowPath(tipX, cy, dir) {
  const base = tipX - dir * 11;
  return `M ${tipX} ${cy} L ${base} ${cy - 5} L ${base} ${cy + 5} Z`;
}

// How far an arrow that passes its end point runs out beyond the line, in both
// renderers. Enough for the whole head and a few pixels of shaft to clear the coloured
// field, so it reads as leaving the scale rather than as sitting on its end.
const RUN_OUT = 18;

// Nothing here measures text, so widths are estimated the way the rest of the module
// does. 6.3 is a shade generous for 12px tabular digits, which is the safe direction: it
// makes a label step out of the way slightly too eagerly rather than slightly too late.
const textW = (t) => String(t).length * 6.3;

// Where a projected value goes — the same rule in both renderers.
//
// IN FRONT of the arrow, in its direction of travel: that is where the eye already is,
// and the number reads as the end of that arrow rather than as one floating near it. If
// it will not fit between the tip and the end of the plot, it goes ABOVE the tip instead,
// which is empty ground except on a shared scale, where the latest value sits above the
// dot. `avoid` is that label's span, and the text slides clear of it — right if there is
// room, left otherwise — rather than being drawn on top of it.
// `lo` is how far left the label may reach ON the line — out into the back gutter, where
// a worsening arrow already points. `plotLo` is the plot's own left edge, which is where
// an ABOVE label has to stop instead: the gutter is room for the arrow, and on a grid
// panel the latest value is sitting just outside it.
function projLabelSpot(txt, { tipX, dir, cy, lo, hi, plotLo = lo, avoid }) {
  const w = textW(txt);
  const x = tipX + dir * 7;
  const end = x + dir * w;
  if (dir > 0 ? end <= hi : end >= lo) {
    return { x, y: cy, anchor: dir > 0 ? "start" : "end" };
  }
  let cx = Math.min(hi - w / 2, Math.max(plotLo + w / 2, tipX));
  if (avoid && cx + w / 2 > avoid[0] && cx - w / 2 < avoid[1]) {
    const right = avoid[1] + w / 2 + 5;
    cx = right + w / 2 <= hi ? right : avoid[0] - w / 2 - 5;
  }
  return { x: cx, y: cy - 12, anchor: "middle" };
}

// Two thick arrows across the top of the plot: red pointing left, "Bad"; green pointing
// right, "Good". Asked for on 2026-09-25 because the comparison figure's scale runs
// backwards for anything that aims to fall — the highest mortality sits at the left and
// zero at the right — and readers were taking the axis the wrong way round.
//
// It is true of every row this module draws, whatever the scale: a row always runs from
// its worst value on the left to its goalpost on the right. So it is on by default for the
// figures whose rows are LOCATIONS, where the numbers on the axis invite the misreading,
// and a caller can switch it with `directionKey`. Drawn into the SVG rather than beside
// it, so a download, the paper's exporter and the PDF one-off all carry it without being
// told to.
const DIR_KEY_H = 34;
const directionKeyOn = (cfg, locationRows) => cfg.directionKey ?? locationRows;

function drawDirectionKey(svg, x0, x1) {
  const cy = 14, shaft = 9, head = 13, len = Math.min(96, Math.max(60, (x1 - x0) * 0.3));
  const arrow = (tip, dir, fill, label) => {
    const neck = tip - dir * 16;
    const tail = tip - dir * len;
    svg.appendChild(el("path", {
      class: "dir-arrow",
      d: `M ${tip} ${cy} L ${neck} ${cy - head} L ${neck} ${cy - shaft} L ${tail} ${cy - shaft}`
        + ` L ${tail} ${cy + shaft} L ${neck} ${cy + shaft} L ${neck} ${cy + head} Z`,
      fill,
    }));
    svg.appendChild(el("text", {
      class: "dir-label", x: (neck + tail) / 2, y: cy, "text-anchor": "middle",
      "dominant-baseline": "central",
    }, label));
  };
  arrow(x0, -1, STATUS.critical.fill, "Bad");
  arrow(x1, 1, STATUS.good.fill, "Good");
}

// ---------------------------------------------------------------------------
// Rows
// ---------------------------------------------------------------------------
// Which outcomes a figure draws. Supplementary ones are OPT-IN: an outcome added to the
// data must never put itself into a figure, so the default here is the core set and a
// caller that wants extras passes the whole list. Every place that enumerates outcomes
// goes through this, or the three of them drift.
function outcomeKeys(cfg) {
  const S = cfg.summary;
  return cfg.outcomeList
    ?? Object.keys(S.outcomes).filter((k) => !S.outcomes[k].supplementary);
}

// An indicator's name as a row or panel shows it: with its years after it where it was
// measured once, since that row has no arrow to date it.
export const rowName = (meta) =>
  meta.label + (meta.singleObservation ? ` (${meta.period ?? meta.latestYear})` : "");

function buildRows(cfg) {
  const { summary: S, locations: L, mode, sexes, trends } = cfg;
  const rows = [];

  const keys = mode === "outcomes"
    ? outcomeKeys(cfg).map((o) => ({ outcome: o, iso3: cfg.location }))
    : (cfg.locationList ?? []).map((c) => ({ outcome: cfg.outcome, iso3: c }));

  for (const { outcome, iso3 } of keys) {
    const meta = S.outcomes[outcome];
    const row = {
      outcome, iso3, meta,
      // Indicators are named in full, with their scale, rather than abbreviated.
      // An outcome measured once has no trend and never will, so the row carries the years
      // it rests on after its name. Without them a reader sees a dot with no arrow and reads
      // it as data we failed to project. It used to carry an asterisk, which nothing on an
      // exported figure explained.
      label: mode === "outcomes" ? rowName(meta) : (L.locations[iso3]?.label ?? iso3),
      sublabel: mode === "outcomes" ? meta.unit : null,
      // What this row can be panelled by. Read from locations.json, so a row keeps its
      // group even when the outcome on screen has nothing to do with mortality.
      group: { mortTercile: L.locations[iso3]?.mortTercile ?? "none" },
      tracks: [],
    };
    const byOutcome = S.data[iso3]?.[outcome];

    // One track per sex AND per trend window. The windows share a latest value, so the
    // dot repeats down the group — but each then gets its own line and its own arrow,
    // named in the key at the right, rather than several arrows crowding a single line
    // and competing for label space.
    for (const sx of sexes) {
      const rec = byOutcome?.[sx];
      if (!rec) continue;
      for (const w of trends) {
        const t = rec.t?.[w];
        // The two halves of the key are kept apart so the sex can be set in bold and the
        // window stay quiet behind it, and joined for the places that want one string.
        const keySex = sexes.length > 1 ? SEX_KEY[sx] : "";
        const keyWindow = trends.length > 1 ? shortWindow(w) : "";
        row.tracks.push({
          row,
          sex: sx, window: w,
          keySex, keyWindow, key: [keySex, keyWindow].filter(Boolean).join(" "),
          latest: rec.v, latestYear: rec.y,
          // `g` is a per-location goalpost and wins where it exists. Height has one:
          // its goal is an absolute gain, so the goalpost is this location's own latest
          // height plus the largest 25-year gain on record, and there is no single number
          // for the outcome to fall back to. `goalpostHolder` names the country and
          // window; do not hardcode them here.
          goalpost: rec.g ?? meta.goalpost?.[sx], best: meta.best?.[sx],
          projections: t
            ? [{ window: w, from: t[0], to: t[1], rate: t[2], proj: t[3], pct: t[4] }]
            : [],
        });
      }
    }
    rows.push(row);
  }
  return rows;
}

// Split rows into stacked groups, preserving the caller's order inside each. Returns a
// single unlabelled panel when panelling is off, so the layout below has one shape to
// deal with and the unpanelled figure is drawn by exactly the same code.
function buildPanels(rows, cfg) {
  const spec = cfg.mode === "locations" ? PANELS[cfg.panelBy] : null;
  if (!spec) return [{ key: null, label: null, rows }];
  return spec.order
    .map((k) => ({ key: k, label: spec.label[k], rows: rows.filter((r) => r.group?.[cfg.panelBy] === k) }))
    .filter((p) => p.rows.length > 0);
}

// ---------------------------------------------------------------------------
// Scale
// ---------------------------------------------------------------------------
function makeScale(cfg, rows) {
  const log = cfg.scale === "log";

  // "shared" pins every row's left edge to the worst value on screen, so the rows
  // are directly comparable in the outcome's own units. "own" starts each row at its
  // own latest value, which makes every row's arrow read as share-of-gap-closed
  // instead. Indicator mode is always "own" — the units differ per row, so a shared
  // value scale would be meaningless.
  const shared = cfg.mode === "locations" && cfg.rowScale !== "own";
  const meta = rows[0]?.meta;
  const lower = meta?.direction === "lower";
  let sharedLeft = null;
  let sharedRight = null;
  let sharedBest = null;
  if (shared) {
    const vals = rows.flatMap((r) => r.tracks.map((t) => t.latest)).filter((v) => v != null);
    sharedLeft = vals.length ? (lower ? Math.max(...vals) : Math.min(...vals)) : null;
    // BOTH ends have to be shared, or "one shared scale" is a different scale on every
    // row. It used to be enough to pin the left, because the goalpost was one number for
    // the whole outcome; height's is per location, so without this its rows would each be
    // drawn against their own right endpoint and two dots at the same height would land
    // in different places. The furthest goalpost wins, so the axis is one ruler in the
    // outcome's own units and every dot sits at its value.
    const gps = rows.flatMap((r) => r.tracks.map((t) => t.goalpost)).filter((v) => v != null);
    if (gps.length) sharedRight = lower ? Math.min(...gps) : Math.max(...gps);
    // And so does the endpoint a zero goalpost falls back to on a log axis, for the same
    // reason: `best` is published per SEX, so taking it per track would put Male and
    // Female on two different rulers while the axis described only the first one.
    const bs = rows.flatMap((r) => r.tracks.map((t) => t.best)).filter((v) => v != null);
    if (bs.length) sharedBest = lower ? Math.min(...bs) : Math.max(...bs);
  }

  const domain = (track) => {
    const L = sharedLeft ?? track.latest;
    let R = sharedRight ?? track.goalpost;
    // A log axis cannot reach zero, so an outcome aiming at zero gets half the best value
    // any location currently achieves. Height aims at a positive value already.
    const bestEnd = shared ? sharedBest : track.best;
    if ((log || cfg.rightEnd === "halfBest") && R === 0 && bestEnd != null) R = bestEnd / 2;
    return [L, R];
  };
  domain.sharedLeft = sharedLeft;
  return domain;
}

function positioner(cfg, domain) {
  const log = cfg.scale === "log";
  return function pos(track, value) {
    const [L, R] = domain(track);
    if (value == null || !Number.isFinite(value) || L === R) return null;
    if (log) {
      if (value <= 0 || L <= 0 || R <= 0) return null;
      return (Math.log(value) - Math.log(L)) / (Math.log(R) - Math.log(L));
    }
    return (value - L) / (R - L);
  };
}

// ---------------------------------------------------------------------------
// Render
// ---------------------------------------------------------------------------
export function prospectChart(host, cfg) {
  host.textContent = "";
  const S = cfg.summary;
  const bands = S.meta.bands;
  // Rows are reordered into panel order once, here, so every loop below can stay a flat
  // pass over `rows` and the panels only have to supply headings and band extents.
  const ordered = buildRows(cfg);
  const panels = buildPanels(ordered, cfg);
  const rows = panels.flatMap((p) => p.rows);

  // ONE SCALE PER PANEL. Unpanelled that is one scale over every row, which is what it
  // has always been. Panelled, on a shared value scale, it makes "highest value shown"
  // mean the highest value in THIS panel — which is the comparison a panel exists to
  // make, and is why the option is worth having at all: forty countries on one ruler put
  // the low-mortality panel in the leftmost tenth of it.
  //
  // The price is that one axis can no longer describe two rulers, so a panelled shared
  // scale draws an axis under each panel. A per-row scale needs none of that: every row
  // already has its own domain and the axis reads in per cent, which is the same per cent
  // in every panel.
  for (const p of panels) {
    p.domain = makeScale(cfg, p.rows);
    p.pos = positioner(cfg, p.domain);
    for (const r of p.rows) r.panel = p;
  }
  const sharedScale = panels[0]?.domain.sharedLeft != null;
  const perPanelAxis = sharedScale && panels.length > 1;
  const posOf = (t) => t.row.panel.pos;

  const width = Math.max(320, host.clientWidth || 660);
  // Compact stacks each row's label above its line instead of holding a left column, so
  // the threshold is the width at which that column stops fitting — not a device size.
  const compact = width < 540;
  // Indicator names carry their unit on a second line, so that column is wider than
  // the location names in comparison mode. Location names are the reader's choice and run
  // to "Western Pacific and Southeast Asia", so that column is measured, the way the grid
  // measures its own, and bounded: 124 so short names keep the plot where it always was,
  // and 30% of the width so one long name cannot take the plot with it. At a flat 124 a
  // long name ran underneath the start of its own line.
  const nameW = cfg.mode === "outcomes" ? 0
    : Math.max(0, ...rows.map((r) => textW(r.label) + 12));
  const labelW = cfg.mode === "outcomes" ? 172
    : Math.max(124, Math.min(nameW, 240, width * 0.3));
  // With a shared scale the left edge is one number for the whole figure, printed on
  // the axis, so no per-row value column is needed. The column is narrow because the
  // value no longer carries its year: the years differ by indicator and it matters
  // (docs/DECISIONS ADR-023), but they are stated once in the legend rather than on
  // every mark.
  const valueW = sharedScale ? 8 : 48;
  const gutterL = compact ? 12 : labelW + valueW;

  // Who carries identity. Only a per-row scale frees the arrows for it — a shared scale
  // has already spent arrow colour on status, because its rows have no drawable bands.
  const seriesKeys = seriesKeysOf(cfg);
  const colorSeries = !sharedScale && seriesKeys.length > 1
    && seriesKeys.length <= SERIES.length;
  const textKeys = seriesKeys.length > 1 && !colorSeries;
  const arrowFill = (t, st) => sharedScale ? (STATUS[st]?.fill ?? "currentColor")
    : colorSeries ? SERIES[Math.max(0, seriesKeys.indexOf(t.key))] : "var(--chart-mark)";

  // The right margin carries the goal value, and a text key behind it only where colour
  // could not do the job — measured from the longest key actually on screen.
  const keyW = textKeys && !compact
    ? Math.max(0, ...seriesKeys.map((k) => k.length)) * 6.4 + 7 : 0;
  const padR = compact ? 62 : 84 + keyW;
  // Row rhythm is set by the tallest thing riding a line, not by the marks — a 10px dot
  // and a 10px arrowhead need very little. It is 30 because a line can carry a number
  // ABOVE it: a projected value that will not fit in front of its arrow goes there, and
  // at 26 it grazed the label sitting in front of the arrow on the line above by a pixel
  // or two. Measured, not guessed — tools/screenshot.mjs asserts no two value labels
  // overlap in any reachable state.
  // 36 where a value sits ABOVE a line — a shared scale puts it there, and so does the
  // compact layout — because with several sexes on screen each group carries one, and at
  // 30 a group's value reached up into the projected value sitting on the line above it.
  // 30 elsewhere, which is what the projected value alone needs.
  const trackH = sharedScale || compact ? 36 : 30;
  const rowPad = compact ? 26 : 10;

  // A projection can land off the left end of the scale — always, on a per-row scale,
  // where the left end IS today's value, so any worsening is beyond it. Those arrows run
  // into a gutter outside the plot and print their value at the tip, since there is no
  // position to read them off. Anything still on scale needs neither.
  const offScale = (t, pr) => pr.proj != null && (posOf(t)(t, pr.proj) ?? -1) < 0;
  const anyOff = rows.some((r) => r.tracks.some((t) => t.projections.some((pr) =>
    pr.pct != null && offScale(t, pr))));
  const backGutter = anyOff ? 66 : 0;
  // A projection can also land past the RIGHT end: height's end point adds the largest
  // 25-year gain on record, and a country whose recent decade beats it projects past
  // that (ADR-045). Clamped to the end, its arrow would read as exactly 100%, so it runs
  // a short way out past the line and its field instead, into room taken from in front
  // of the goal value. How far past is in its value label and hover, not in the length.
  const anyOver = rows.some((r) => r.tracks.some((t) => t.projections.some((pr) =>
    pr.pct != null && pr.proj != null && (posOf(t)(t, pr.proj) ?? 0) > 1)));
  const runOut = anyOver ? RUN_OUT : 0;
  const plotX = gutterL + backGutter;
  const plotW = width - plotX - padR - runOut;

  // The axis names what the scale actually is. A per-row scale is a share of each row's
  // own gap, so it reads in per cent; a shared scale is real values in the outcome's
  // units, where per cent would be a different quantity on every row and mean nothing.
  const axisTitle = sharedScale && rows[0]?.meta
    ? fullName(rows[0].meta)
    : `Share of the distance to the target closed by ${S.meta.targetYear}`
      + ` if recent trends continue`;
  const titleLines = compact && !sharedScale
    ? [`Share of the distance to the target closed by ${S.meta.targetYear}`,
       "if recent trends continue"]
    : [axisTitle];
  // Split, because a panelled figure repeats the TICKS under every panel and the title
  // only under the last: three identical axis titles say nothing the first did not.
  const tickH = 30;
  const titleH = 16 + (titleLines.length - 1) * 14;
  const axisH = tickH + titleH;

  // Bands encode "share of the gap closed", which is only a fixed position when each
  // row starts from its own latest value.
  const showBands = !sharedScale;

  // A panel heading needs a line of its own, plus air above it so it reads as belonging
  // to what follows rather than to what it sits under.
  const panelHeadH = 34;

  // Which panels get an axis, decided before the layout so the space can be reserved. A
  // panel whose rows are all "no data available" gets none — there is nothing to read off
  // it — which is why this cannot simply be the last panel: on a figure ending in the
  // no-estimate group, reserving the title's space at the foot would leave it empty.
  const axisPanels = perPanelAxis
    ? panels.filter((p) => p.rows.some((r) => r.tracks.length)) : [];
  const lastAxisPanel = axisPanels[axisPanels.length - 1];

  // Room for the Good/Bad arrows above everything else, when they are drawn.
  const dirH = directionKeyOn(cfg, cfg.mode === "locations") ? DIR_KEY_H : 0;
  let y = 12 + dirH;
  for (const p of panels) {
    if (p.label) { y += panelHeadH; p.headY = y - 13; }
    // Where this panel's background band starts. Unpanelled, it is the old constant 6,
    // so the figure without panels is drawn pixel for pixel as it was.
    p.bandTop = p.label ? y - 8 : 6 + dirH;
    for (const r of p.rows) {
      const n = Math.max(r.tracks.length, 1);
      if (compact) { r.labelY = y + 4; y += r.sublabel ? 34 : 20; }
      r.y = y;
      if (!compact) r.labelY = y + n * trackH / 2;
      y += n * trackH + rowPad;
    }
    p.bandBottom = y - rowPad + 8;
    if (axisPanels.includes(p)) {
      p.axisY = y - rowPad + 12;
      y = p.axisY + tickH + (p === lastAxisPanel ? titleH : 0);
    }
  }
  const plotBottom = y;
  if (panels.length === 1 && !panels[0].label) panels[0].bandBottom = plotBottom;
  const height = plotBottom + (perPanelAxis ? 8 : axisH);

  const svg = el("svg", {
    class: "prospect-svg", width, height,
    viewBox: `0 0 ${width} ${height}`, role: "img",
    "aria-label": cfg.title ?? "Prospects for halving the distance to the target by 2050",
  });
  if (dirH) drawDirectionKey(svg, plotX, plotX + plotW);

  // --- background bands -----------------------------------------------------
  // Band edges are the VALUES at 25% and 50% of the gap closed, mapped through
  // whatever scale is active — drawing them at fixed pixel fractions would silently
  // misstate them the moment the axis goes log.
  const bandEdges = (t) => {
    const [L] = t.row.panel.domain(t);
    return bands.map((q) => posOf(t)(t, L + q * (t.goalpost - L)));
  };
  const allEdges = showBands
    ? rows.flatMap((r) => r.tracks.map(bandEdges)).filter((e) => e.every((v) => v != null))
    : [];
  const aligned = allEdges.length > 0 && allEdges.every((e) =>
    e.every((v, i) => Math.abs(v - allEdges[0][i]) < 0.002));
  const bandDefs = [["critical", 0], ["warning", 1], ["good", 2]];

  if (aligned) {
    const stops = [0, allEdges[0][0], allEdges[0][1], 1];
    // One field per panel rather than one for the figure, so the headings sit on the
    // page ground instead of over a coloured wash. The edges are the same in every panel
    // because `aligned` is only true when they are.
    for (const p of panels) {
      bandDefs.forEach(([k], i) => {
        const x0 = plotX + Math.max(0, stops[i]) * plotW;
        const x1 = plotX + Math.min(1, stops[i + 1]) * plotW;
        svg.appendChild(el("rect", {
          class: `band band-${k}`, x: x0, y: p.bandTop, width: Math.max(0, x1 - x0),
          height: Math.max(0, p.bandBottom - p.bandTop), fill: STATUS[k].fill,
        }));
      });
    }
  }

  // --- panel headings -------------------------------------------------------
  // Drawn after the bands and before the rows. The rule is what separates two panels on
  // a shared value scale, where there are no bands to do it.
  panels.forEach((p, i) => {
    if (!p.label) return;
    if (i > 0) {
      svg.appendChild(el("line", {
        class: "panel-rule", x1: 0, x2: width, y1: p.headY - 15, y2: p.headY - 15,
      }));
    }
    svg.appendChild(el("text", {
      class: "panel-title", x: compact ? plotX : 0, y: p.headY,
      "dominant-baseline": "middle",
    }, p.label));
  });

  // --- rows -----------------------------------------------------------------
  for (const r of rows) {
    const meta = r.meta;
    // An outcome measured once has no goal (2026-09-25): with no trend there is nothing to
    // halve, so it gets its dot and its value and none of the goal's furniture — no line
    // running to a goalpost, no goal value, and no status field behind it. Where the field
    // is one block for the whole panel, this row is knocked out of it.
    const noGoal = !!meta.singleObservation;
    if (noGoal && aligned) {
      // Out to the panel's own band edges where the row is its first or last, or a strip of
      // the field is left showing above or below it.
      const n = Math.max(r.tracks.length, 1);
      const p = r.panel;
      // A pixel past the field at its edges, which anti-aliasing otherwise leaves as a hairline.
      const top = p.rows[0] === r ? p.bandTop - 1 : r.y - rowPad / 2;
      const bottom = p.rows[p.rows.length - 1] === r ? p.bandBottom + 1
        : r.y + n * trackH + rowPad / 2;
      svg.appendChild(el("rect", {
        class: "band-knockout", x: plotX, y: top, width: plotW, height: bottom - top,
      }));
    }

    svg.appendChild(el("text", {
      class: "row-label", x: compact ? plotX : 0,
      y: r.sublabel ? r.labelY - (compact ? 0 : 7) : r.labelY,
      "text-anchor": "start", "dominant-baseline": "middle",
    }, r.label));
    if (r.sublabel) {
      svg.appendChild(el("text", {
        class: "row-sublabel", x: compact ? plotX : 0,
        y: r.labelY + (compact ? 14 : 8), "text-anchor": "start",
        "dominant-baseline": "middle",
      }, r.sublabel));
    }

    if (r.tracks.length === 0) {
      svg.appendChild(el("text", {
        class: "row-nodata", x: plotX + 4, y: r.y + trackH / 2, "dominant-baseline": "middle",
      }, "no data available"));
      continue;
    }

    // Lines that share a sex share a latest value and a goalpost, so those two labels
    // are printed once and centred on the group — on the middle line of three, between
    // the inner two of four — rather than repeated identically down every line.
    const groups = [];
    for (const t of r.tracks) {
      const g = groups[groups.length - 1];
      if (g && g.sex === t.sex) g.tracks.push(t);
      else groups.push({ sex: t.sex, tracks: [t], at: r.tracks.indexOf(t) });
    }

    // Where the latest value is about to be printed ABOVE a line, so an arrow's own
    // label can step around it. Only a shared scale puts it there; a per-row scale keeps
    // it in the left gutter, where nothing else goes.
    const valAbove = new Map();
    if (sharedScale || compact) {
      // `pos` is per panel and the row knows its own; the tracks loop below rebinds it
      // locally, which is not in scope out here.
      const rpos = r.panel.pos;
      for (const g of groups) {
        const t = g.tracks[0];
        const q = rpos(t, t.latest);
        if (q == null) continue;
        const w = textW(`${num(t.latest)}${compact && t.key ? " · " + t.key : ""}`);
        const dx = plotX + Math.max(0, Math.min(1, q)) * plotW;
        valAbove.set(g.at, sharedScale ? [dx - w / 2, dx + w / 2] : [plotX, plotX + w]);
      }
    }

    r.tracks.forEach((t, i) => {
      const cy = r.y + i * trackH + trackH / 2;

      if (showBands && !aligned && !noGoal) {
        const e = bandEdges(t);
        if (e.every((v) => v != null)) {
          const stops = [0, e[0], e[1], 1];
          bandDefs.forEach(([k], j) => {
            const x0 = plotX + Math.max(0, Math.min(1, stops[j])) * plotW;
            const x1 = plotX + Math.max(0, Math.min(1, stops[j + 1])) * plotW;
            svg.appendChild(el("rect", {
              class: `band band-${k}`, x: x0, y: cy - 12,
              width: Math.max(0, x1 - x0), height: 24, fill: STATUS[k].fill,
            }));
          });
        }
      }

      // The line runs to THIS row's goal, which is the right edge of the plot for every
      // scale where the goalpost is one number. On a shared scale with per-location
      // goalposts it is not, and a shorter line is what says "your goal is nearer".
      // A log axis cannot place a goalpost of zero, so it falls back to the full width,
      // which is where the axis already ends.
      const pos = t.row.panel.pos;
      const pGoal = pos(t, t.goalpost);
      const goalX = plotX + (pGoal == null ? 1 : Math.max(0, Math.min(1, pGoal))) * plotW;
      // On a shared scale the line is the value ruler every row reads against, so it stays.
      if (!noGoal || sharedScale) {
        svg.appendChild(el("line", {
          class: "track-line", x1: plotX, x2: goalX, y1: cy, y2: cy,
        }));
      }

      const pLatest = pos(t, t.latest);
      const dotX = plotX + Math.max(0, Math.min(1, pLatest ?? 0)) * plotW;
      const fill = arrowFill(t, null);

      // Geometry for every arrow on this line, worked out once so the connectors can be
      // drawn UNDER the dot and the arrowheads. An off-scale projection has no position,
      // so it runs into the back gutter to show direction and prints its value there.
      const arrows = t.projections
        .filter((pr) => pr.pct != null && pr.proj != null)
        .map((pr) => {
          const p = pos(t, pr.proj);
          const off = p == null || p < 0;
          return {
            pr, off, dir: pr.pct >= 0 ? 1 : -1, st: statusOf(pr.pct, bands),
            // Off-scale arrows stop short of the gutter's left edge, leaving room for
            // the value; on-scale ones sit at their true position, which for a worsening
            // trend is left of the dot — the side it is actually heading.
            tipX: off ? Math.max(gutterL + 34, dotX - backGutter + 4)
              : p > 1 ? plotX + plotW + runOut - 3 : plotX + p * plotW,
          };
        });

      for (const a of arrows) {
        svg.appendChild(el("line", {
          class: "proj-connector", x1: dotX, y1: cy, x2: a.tipX - a.dir * 9, y2: cy,
          stroke: sharedScale ? (STATUS[a.st]?.fill ?? "currentColor") : fill,
        }));
      }

      if (pLatest != null) {
        const dot = el("circle", { class: "mark-latest", cx: dotX, cy, r: 5 });
        dot.appendChild(el("title", {},
          `${r.label} · ${SEX_LONG[t.sex]}\n${num(t.latest)} ${meta.unit} (${t.latestYear})`));
        svg.appendChild(dot);
      }

      // Arrowheads, drawn over the dot and its connectors.
      const lo = plotX - backGutter;
      const hi = plotX + plotW;
      for (const { pr, dir, st, tipX } of arrows) {
        const g = el("g", { class: "mark-proj", tabindex: "0" });
        g.appendChild(el("path", {
          class: "proj-arrow", d: arrowPath(tipX, cy, dir),
          fill: sharedScale ? (STATUS[st]?.fill ?? "currentColor") : fill,
        }));
        // A projection held at the measure's ceiling has to say so: repeated identical
        // values otherwise read as a coincidence rather than as a bound.
        const held = meta.valueMax != null && pr.proj >= meta.valueMax;
        g.appendChild(el("title", {},
          `${r.label} · ${SEX_LONG[t.sex]} · ${windowLabel(pr.window)} trend `
          + `(${pr.from}–${pr.to})\n${num(pr.proj)} ${meta.unit} by `
          + `${S.meta.targetYear} if this trend continues`
          + `${held ? " — held at the most this measure can be" : ""}`
          + `\n${Math.round(pr.pct * 100)}% of the distance to the target closed — `
          + `${STATUS[st]?.label}`));
        svg.appendChild(g);

        // Every arrow carries its projected value, not just the ones running off the
        // scale. A dot labelled with today and an arrow labelled with 2050 is the whole
        // figure in two numbers; leaving the second to a hover made it the one thing
        // nobody could read off the page.
        const txt = num(pr.proj);
        const spot = projLabelSpot(txt, {
          // An arrow past its end point may carry its value over the run-out, above itself.
          tipX, dir, cy, lo, hi: tipX > hi ? hi + runOut : hi, plotLo: plotX,
          avoid: valAbove.get(i),
        });
        svg.appendChild(el("text", {
          class: pr.pct < 0 ? "proj-label worsening" : "proj-label",
          x: spot.x, y: spot.y, "text-anchor": spot.anchor,
          "dominant-baseline": spot.y === cy ? "middle" : "auto",
        }, txt));
      }
    });

    // Group labels — the latest value on the left and the goal on the right, once per
    // sex, centred on that sex's block of lines.
    for (const g of groups) {
      const first = g.at;
      const last = g.at + g.tracks.length - 1;
      const gcy = r.y + (first + last) * trackH / 2 + trackH / 2;
      const t = g.tracks[0];
      const pos = t.row.panel.pos;
      const valText = `${num(t.latest)}${compact && t.key ? " · " + t.key : ""}`;

      // With a shared scale the dot moves along the axis, so its value belongs above the
      // block. With a per-row scale every dot sits at the left edge and the value goes in
      // the gutter, where it lines up down the figure.
      if (pos(t, t.latest) != null) {
        const dotX = plotX + Math.max(0, Math.min(1, pos(t, t.latest))) * plotW;
        svg.appendChild(el("text", {
          class: "val-label",
          x: sharedScale ? dotX : compact ? plotX : gutterL - 10,
          // 14, not 11: the projected value now sits ON the line directly beneath this
          // one, and at 11 the two boxes grazed by a pixel. The extra room exists because
          // a line is 30px rather than 26.
          y: sharedScale || compact ? r.y + first * trackH + trackH / 2 - 14 : gcy,
          "text-anchor": sharedScale ? "middle" : compact ? "start" : "end",
          "dominant-baseline": sharedScale || compact ? "auto" : "middle",
        }, valText));
      }

      if (noGoal) continue;
      const gl = el("text", {
        class: "goal-label", x: plotX + plotW + runOut + 10, y: gcy, "dominant-baseline": "middle",
      });
      gl.appendChild(el("tspan", {}, num(t.goalpost)));
      if (textKeys && !compact) {
        // Colour could not separate this many lines, so each is named instead. The key
        // belongs per line, not per group, so it is the one thing still repeated.
        g.tracks.forEach((tk, j) => {
          svg.appendChild(el("text", {
            class: "track-key", x: plotX + plotW + runOut + 34,
            y: r.y + (first + j) * trackH + trackH / 2, "dominant-baseline": "middle",
          }, tk.key));
        });
      }
      svg.appendChild(gl);
    }
  }

  // --- axis -----------------------------------------------------------------
  // Ticks sit at their true positions, so under a log axis they bunch up. That is the
  // honest rendering: position stops being linear in "share closed".
  //
  // Where every panel shares one ruler, one axis at the foot of the figure describes it.
  // Where they do not — a shared VALUE scale split into panels — each panel gets its own
  // ticks, because an axis that described only the first panel would be a quietly wrong
  // reading of every other one. The title still appears once.
  const drawAxis = (refTrack, panel, ay, withTitle) => {
    const [L0, R0] = panel.domain(refTrack);
    const at = panel.pos;
    svg.appendChild(el("line", {
      class: "axis-rule", x1: plotX, x2: plotX + plotW, y1: ay, y2: ay,
    }));
    // A shared scale is measured in values, so it ticks at round values wherever they
    // land. A per-row scale is measured in share of that row's own gap, so it ticks at
    // even shares of the gap and reports per cent.
    const ticks = sharedScale
      ? niceTicks(L0, R0).map((v) => [at(refTrack, v), num(v)])
      : [0, 0.25, 0.5, 0.75, 1].map((q) =>
        [at(refTrack, L0 + q * (refTrack.goalpost - L0)), `${Math.round(q * 100)}%`]);
    for (const [q, label] of ticks) {
      if (q == null || q < -0.01 || q > 1.01) continue;
      const x = plotX + q * plotW;
      svg.appendChild(el("line", { class: "axis-tick", x1: x, x2: x, y1: ay, y2: ay + 4 }));
      svg.appendChild(el("text", {
        class: "axis-label", x, y: ay + 17, "text-anchor": "middle",
      }, label));
    }
    if (!withTitle) return;
    titleLines.forEach((line, i) => {
      svg.appendChild(el("text", {
        class: "axis-title", x: plotX + plotW / 2, y: ay + 34 + i * 14,
        "text-anchor": "middle",
      }, line));
    });
  };

  if (perPanelAxis) {
    for (const p of axisPanels) {
      drawAxis(p.rows.flatMap((r) => r.tracks)[0], p, p.axisY, p === lastAxisPanel);
    }
  } else {
    // Taken from the CALLER's order, not the panel order: the axis is drawn off one row,
    // so reading it from `rows` would let turning panels on silently redraw it.
    const ref = ordered.flatMap((r) => r.tracks)[0];
    if (ref) drawAxis(ref, ref.row.panel, plotBottom + 8, true);
  }

  CHART_CFG.set(svg, cfg);
  host.appendChild(svg);
  // Several charts on a page share one legend rather than repeating it — the caller
  // opts out here and places it once itself.
  if (cfg.legend !== false) host.appendChild(prospectLegend(cfg));
  optionsPanel(host).appendChild(tableView(panels, cfg));
}

// ---------------------------------------------------------------------------
// Grid — the selection on ONE figure, a panel each
// ---------------------------------------------------------------------------
// Small multiples of the prospect chart: same marks, same bands, same scales, so a panel
// here reads exactly like the standalone figure does. `gridBy` decides what a panel IS,
// and the two readings answer different questions:
//
//   "location" (default)  a panel per selected location, the five indicators as its rows.
//                         "How is each of these places doing across the board?"
//   "outcome"             a panel per indicator, the selected locations as its rows.
//                         "How do these places compare, on all five at once?"
//
// One thing has to give either way, and it is a consequence of the cells being narrow:
// the row names are drawn ONCE down the left of each band of panels rather than inside
// every panel, because at three columns there is no room to repeat them.
//
// `rowScale` reaches only the indicator reading, and it reaches it whole: "own" gives
// every row its own gap and the 0-100% axis all five panels can share, while "shared"
// gives each PANEL its own ruler in its own units. A panel of locations is one indicator,
// so it can have a shared value scale; a panel of indicators is five units, so it cannot,
// and `makeScale` refuses it there without being asked.
//
// It is one <svg>, which is the point: one legend, one download, one table, and the
// panels are guaranteed to be on the same scale because they are drawn by one pass.
export function prospectGrid(host, cfg) {
  host.textContent = "";
  const S = cfg.summary;
  const L = cfg.locations;
  const bands = S.meta.bands;
  const codes = (cfg.locationList ?? []).filter((c) => L.locations[c]);
  if (!codes.length) return;
  const byOutcome = cfg.gridBy === "outcome";

  // Each panel is built by the same `buildRows` the standalone chart uses, with the row
  // semantics flipped between the two readings.
  //
  // A figure with no "Line starts at" control has not asked for a shared value scale, so
  // an absent `rowScale` means per-row rather than the caller's default. Pinning it that
  // way here is what keeps the five-indicator figure — which has no such control — off a
  // scale it never offered.
  const rowScale = cfg.rowScale ?? "own";
  const sub = { ...cfg, mode: byOutcome ? "locations" : "outcomes", rowScale,
    locationList: codes };
  const panels = byOutcome
    ? outcomeKeys(cfg).map((key) => ({
      key,
      label: rowName(S.outcomes[key]),
      sublabel: S.outcomes[key].unit,
      rows: buildRows({ ...sub, outcome: key }),
    }))
    : codes.map((code) => ({
      key: code, label: L.locations[code].label, sublabel: null,
      rows: buildRows({ ...sub, location: code }),
    }));
  // ONE SCALE PER PANEL, the way the standalone chart does it when panelled. On a per-row
  // scale every row already has its own domain and this changes nothing. On a shared value
  // scale it makes "the highest value shown" mean the highest value in THIS panel, which
  // is the only reading available once the panels are five different units — and is the
  // comparison a panel exists to make, per ADR-025.
  for (const p of panels) {
    p.domain = makeScale(sub, p.rows);
    p.pos = positioner(cfg, p.domain);
    for (const r of p.rows) r.panel = p;
  }
  // Declared from the settings rather than read off a domain, so a first panel that
  // happens to hold no data cannot decide it for the other four.
  const sharedScale = byOutcome && rowScale !== "own";

  // Columns. With a panel per location the count follows the selection: one column up to
  // three locations, two up to six, three past that — and three thereafter, growing
  // downwards. Nobody has asked for a fourth column and a cell that narrow would not be
  // a chart.
  //
  // With a panel per indicator there are always five, and five goes 2, 2, 1 down the
  // page. Three columns would put the fifth panel under nothing and leave two thirds of
  // the last band empty.
  //
  // Capped either way by what the width can actually hold, at ~170px of cell each.
  // Without that the rule alone puts nine locations into three columns on a phone and
  // each plot is 60px wide, which is not a smaller chart but a broken one.
  //
  // A caller laying the figure out for a page or a slide (figure-format.js) passes `cols`,
  // which replaces the rule but not the cap: a slide is wide and short, so five indicator
  // panels in one band can be the layout that keeps its labels legible there.
  const n = panels.length;
  const width = Math.max(320, host.clientWidth || 660);
  const wantCols = cfg.cols ?? (byOutcome ? 2 : n <= 3 ? 1 : n <= 6 ? 2 : 3);
  const cols = Math.max(1, Math.min(wantCols, Math.floor((width - 146) / 170)));
  const gridRows = Math.ceil(n / cols);

  // The name column down the left. Indicator names are known and short, so they get a
  // constant. Location names are the reader's choice and run to "Oceania excluding
  // Australia and New Zealand", so that column is measured instead — and bounded at both
  // ends: 146 so a figure of short names still puts its plots where the eye expects them,
  // and 30% of the width so one long name cannot take the plots down with it.
  const nameW = Math.max(0, ...panels[0].rows.map((r) => textW(r.label) + 12));
  const labelW = byOutcome ? Math.max(146, Math.min(nameW, 240, width * 0.3))
    : cols === 1 ? 178 : 146;
  const goalW = cols === 1 ? 46 : 34;
  // Somewhere for a worsening arrow to go: on a per-row scale the dot sits ON the left
  // edge, so an arrow pointing backwards has no room inside the plot at all.
  const backG = 16;
  // On a per-row scale the latest value sits to the LEFT of its dot, in a gutter of its
  // own, the way it does on the standalone chart — every dot is on the left edge there, so
  // the values line up down the figure. It used to sit above the line, which is the one
  // piece of empty ground a PROJECTED value needs when it cannot fit in front of its
  // arrow, and both cannot have it.
  //
  // On a shared scale the dot moves along the axis and the value has to travel with it, so
  // there is no gutter to reserve and the ground above the line is spent after all.
  // `projLabelSpot` is told where it went and slides clear.
  const anyKey = panels.some((p) => p.rows.some((r) => r.tracks.some((t) => t.key)));
  // The key ("Male", "Female") rides along with that value. In the gutter it needs width,
  // so it appears only in the single-column layout; above the dot it costs none, and there
  // it is the ONLY thing separating one sex's line from the next — arrow colour on a
  // shared scale has already been spent on status.
  const showKey = anyKey && (sharedScale || cols === 1);
  const valueW = sharedScale ? 8 : cols === 1 ? (showKey ? 86 : 44) : 32;
  // Room in front of the goal value for an arrow that passes its end point, as on the
  // standalone chart, and only when one does. Every column gets it, so the goal values
  // still line up down and across the figure.
  const anyOver = panels.some((p) => p.rows.some((r) => r.tracks.some((t) =>
    t.projections.some((pr) => pr.pct != null && pr.proj != null
      && (p.pos(t, pr.proj) ?? 0) > 1))));
  const runOut = anyOver ? RUN_OUT : 0;
  const cellW = (width - labelW) / cols;
  const plotW = Math.max(40, cellW - valueW - backG - goalW - 8 - runOut);
  const plotXOf = (col) => labelW + col * cellW + valueW + backG;

  // ONE vertical grid, shared by every panel, sized to the largest track count any
  // location has for that indicator. A panel with fewer leaves its slot part-empty, which
  // is the right trade: otherwise a country missing a sex would shift its neighbours down
  // and the names running along the left edge would stop lining up with anything.
  const slots = panels[0].rows.map((_, i) =>
    Math.max(1, ...panels.map((p) => p.rows[i].tracks.length)));
  // 36 where a value sits ABOVE a line rather than in the gutter, for the same reason the
  // standalone chart goes to 36 there: with several sexes on screen each group carries one,
  // and at 30 a group's value reached up into the projected value on the line above it.
  const trackH = sharedScale ? 36 : 30;
  const rowPad = 8;
  // Room for the panel heading. An indicator panel needs a second line for its unit, the
  // way an indicator ROW carries one in the other reading: the units differ from panel to
  // panel here, so dropping them would leave five plots measured in nothing.
  const headH = byOutcome ? 38 : 24;
  const axisH = 28;
  const gapY = 20;

  // The axis title names what the scale IS, and on a shared value scale there is no single
  // answer: every panel is a different unit, and each already names its own under its
  // heading. So the title appears only where all five panels really do read the same per
  // cent, and the figure is shorter by its height where they do not.
  const axisTitle = sharedScale ? null
    : `Share of the distance to the target closed by ${S.meta.targetYear}`
      + ` if recent trends continue`;

  const rowY = [];
  let ry = headH;
  for (const k of slots) { rowY.push(ry); ry += k * trackH + rowPad; }
  const panelH = ry;
  const bandRowH = panelH + axisH;
  // The Good/Bad arrows go above the first band of panels, once for the whole figure.
  const dirH = directionKeyOn(cfg, byOutcome) ? DIR_KEY_H : 0;
  const bandsH = dirH + gridRows * (bandRowH + gapY) - gapY;
  const titleY = bandsH + 20;
  const height = (axisTitle ? titleY : bandsH) + 8;
  const bandTop = (gr) => dirH + gr * (bandRowH + gapY);

  const svg = el("svg", {
    class: "prospect-svg", width, height,
    viewBox: `0 0 ${width} ${height}`, role: "img",
    "aria-label": cfg.title ?? (byOutcome
      ? "Five indicators, a panel each, over every selected location"
      : "Five indicators, every selected location"),
  });
  if (dirH) drawDirectionKey(svg, plotXOf(0), plotXOf(Math.min(cols, n) - 1) + plotW);

  // Only a per-row scale frees the arrows for identity: a shared scale has already spent
  // arrow colour on status, because its rows have no drawable bands.
  const seriesKeys = seriesKeysOf(cfg);
  const colorSeries = !sharedScale && seriesKeys.length > 1
    && seriesKeys.length <= SERIES.length;
  const arrowFill = (t, st) => sharedScale ? (STATUS[st]?.fill ?? "currentColor")
    : colorSeries ? SERIES[Math.max(0, seriesKeys.indexOf(t.key))] : "var(--chart-mark)";

  // Band edges are the VALUES at 25% and 50% of the gap closed, mapped through this
  // panel's own scale — drawing them at fixed pixel fractions would silently misstate
  // them the moment the axis goes log.
  const bandEdges = (t) => {
    const [lo] = t.row.panel.domain(t);
    return bands.map((q) => t.row.panel.pos(t, lo + q * (t.goalpost - lo)));
  };
  const bandDefs = [["critical", 0], ["warning", 1], ["good", 2]];

  panels.forEach((p, i) => {
    const gr = Math.floor(i / cols);
    const col = i % cols;
    const top = bandTop(gr);
    const plotX = plotXOf(col);
    const pos = p.pos;

    svg.appendChild(el("text", {
      class: "panel-title", x: plotX - backG, y: top + 12, "dominant-baseline": "middle",
    }, p.label));
    // An indicator panel names its unit under its heading. Nothing else in this layout
    // would carry it: the rows are locations and the axis reads in per cent.
    if (p.sublabel) {
      svg.appendChild(el("text", {
        class: "row-sublabel", x: plotX - backG, y: top + 26, "dominant-baseline": "middle",
      }, p.sublabel));
    }

    p.rows.forEach((r, j) => {
      const y0 = top + rowY[j];

      // The names, once per band of panels rather than once per panel. Straddling the
      // FIRST line of the slot, not its middle: with several sexes on screen a slot holds
      // several lines and the name belongs beside the top one, where the eye enters.
      if (col === 0) {
        const ly = y0 + trackH / 2 + 4;
        // Lifted clear of the line only when a sublabel is coming to sit under it. A
        // location name has none, and raising it anyway left it floating above nothing.
        svg.appendChild(el("text", {
          class: "row-label", x: 0, y: r.sublabel ? ly - 5 : ly,
          "dominant-baseline": "middle",
        }, r.label));
        if (r.sublabel) {
          svg.appendChild(el("text", {
            class: "row-sublabel", x: 0, y: ly + 8, "dominant-baseline": "middle",
          }, r.sublabel));
        }
      }

      if (!r.tracks.length) {
        svg.appendChild(el("text", {
          class: "row-nodata", x: plotX, y: y0 + trackH / 2 + 2, "dominant-baseline": "middle",
        }, cols < 3 ? "no data available" : "no data"));
        return;
      }

      r.tracks.forEach((t, k) => {
        const cy = y0 + k * trackH + trackH / 2 + 4;

        // Bands encode "share of the gap closed", which is a fixed position only where
        // each row starts from its own latest value. On a shared value scale every row's
        // gap is a different size, so a single band would be right for at most one of
        // them and the arrows carry status instead.
        const noGoal = !!r.meta.singleObservation;
        if (!sharedScale && !noGoal) {
          const e = bandEdges(t);
          if (e.every((v) => v != null)) {
            const stops = [0, e[0], e[1], 1];
            bandDefs.forEach(([kind], b) => {
              const x0 = plotX + Math.max(0, Math.min(1, stops[b])) * plotW;
              const x1 = plotX + Math.max(0, Math.min(1, stops[b + 1])) * plotW;
              svg.appendChild(el("rect", {
                class: `band band-${kind}`, x: x0, y: cy - 11,
                width: Math.max(0, x1 - x0), height: 22, fill: STATUS[kind].fill,
              }));
            });
          }
        }

        const pGoal = pos(t, t.goalpost);
        const goalX = plotX + (pGoal == null ? 1 : Math.max(0, Math.min(1, pGoal))) * plotW;
        if (!noGoal || sharedScale) {
          svg.appendChild(el("line", {
            class: "track-line", x1: plotX, x2: goalX, y1: cy, y2: cy,
          }));
        }

        const pLatest = pos(t, t.latest);
        const dotX = plotX + Math.max(0, Math.min(1, pLatest ?? 0)) * plotW;

        const arrows = t.projections
          .filter((pr) => pr.pct != null && pr.proj != null)
          .map((pr) => {
            const q = pos(t, pr.proj);
            const off = q == null || q < 0;
            return {
              pr, dir: pr.pct >= 0 ? 1 : -1, st: statusOf(pr.pct, bands),
              tipX: off ? plotX - backG + 4
                : q > 1 ? plotX + plotW + runOut - 3 : plotX + q * plotW,
            };
          });

        for (const a of arrows) {
          svg.appendChild(el("line", {
            class: "proj-connector", x1: dotX, y1: cy, x2: a.tipX - a.dir * 9, y2: cy,
            stroke: arrowFill(t, a.st),
          }));
        }

        if (pLatest != null) {
          const dot = el("circle", { class: "mark-latest", cx: dotX, cy, r: 4.5 });
          dot.appendChild(el("title", {},
            `${p.label} · ${r.label} · ${SEX_LONG[t.sex]}\n`
            + `${num(t.latest)} ${r.meta.unit} (${t.latestYear})`));
          svg.appendChild(dot);
        }

        // Lines that share a sex share a latest value and a goalpost, and lines that do
        // not share neither. Height is the case that makes it matter: its goalpost is
        // built from each sex's own level, so labelling the row once would put the boys'
        // goal beside the girls' line.
        const startsGroup = k === 0 || t.sex !== r.tracks[k - 1].sex;
        const valText = `${num(t.latest)}${showKey && t.key ? " · " + t.key : ""}`;
        // Where that value is about to be printed ABOVE this line, so an arrow's own label
        // slides clear rather than landing on top of it. Only a shared scale puts it
        // there; a per-row scale keeps it in the gutter, where nothing else goes.
        const avoid = sharedScale && startsGroup && pLatest != null
          ? [dotX - textW(valText) / 2, dotX + textW(valText) / 2] : null;

        const lo = plotX - backG;
        const hi = plotX + plotW;
        for (const { pr, dir, st, tipX } of arrows) {
          const g = el("g", { class: "mark-proj", tabindex: "0" });
          g.appendChild(el("path", {
            class: "proj-arrow", d: arrowPath(tipX, cy, dir), fill: arrowFill(t, st),
          }));
          const held = r.meta.valueMax != null && pr.proj >= r.meta.valueMax;
          g.appendChild(el("title", {},
            `${p.label} · ${r.label} · ${SEX_LONG[t.sex]} · `
            + `${windowLabel(pr.window)} trend (${pr.from}–${pr.to})\n`
            + `${num(pr.proj)} ${r.meta.unit} by ${S.meta.targetYear} if this trend continues`
            + `${held ? " — held at the most this measure can be" : ""}\n`
            + `${Math.round(pr.pct * 100)}% of the distance to the target closed — `
            + `${STATUS[st]?.label}`));
          svg.appendChild(g);

          // Every arrow says where it lands, by the same rule the standalone chart uses:
          // in front of the tip, or above it where there is no room in front.
          const txt = num(pr.proj);
          const spot = projLabelSpot(txt, {
            tipX, dir, cy, lo, hi: tipX > hi ? hi + runOut : hi, plotLo: plotX, avoid,
          });
          svg.appendChild(el("text", {
            class: pr.pct < 0 ? "proj-label worsening" : "proj-label",
            x: spot.x, y: spot.y, "text-anchor": spot.anchor,
            "dominant-baseline": spot.y === cy ? "middle" : "auto",
          }, txt));
        }

        // The two group labels, printed once on the group's first line.
        if (startsGroup) {
          if (!sharedScale || pLatest != null) {
            svg.appendChild(el("text", {
              class: "val-label",
              x: sharedScale ? dotX : plotX - backG - 4,
              y: sharedScale ? cy - 14 : cy,
              "text-anchor": sharedScale ? "middle" : "end",
              "dominant-baseline": sharedScale ? "auto" : "middle",
            }, valText));
          }
          // Beside the end of its own line on a per-row scale, where that end IS the
          // right edge of the plot. On a shared scale it is not: height's goalpost is
          // per location, so the line stops short and a label at its end sits INSIDE the
          // plot, in the ground the arrow labels use. So there it goes to the right edge
          // instead, which is what the standalone chart does on every scale.
          if (!noGoal) {
            svg.appendChild(el("text", {
              class: "goal-label", x: (sharedScale ? plotX + plotW : goalX) + runOut + 6,
              y: cy, "dominant-baseline": "middle",
            }, num(t.goalpost)));
          }
        }
      });
    });
  });

  // One tick strip under each band of panels, per column.
  //
  // A per-row scale is measured in share of each row's own gap, so it ticks at even shares
  // and reports per cent; there the bands are the scale and the ticks a reading aid, which
  // is why the narrow layouts drop the quarter marks. A shared value scale is measured in
  // the outcome's own units, so it ticks at round VALUES wherever they land — and there
  // the strip IS the scale, one per panel, because five panels in five units cannot share
  // a ruler.
  //
  // Either way the marks are mapped through the panel's own positioner rather than dropped
  // at pixel fractions: under a log axis those stop being the same thing, and the 100% mark
  // stops existing at all, since a log axis cannot reach a goalpost of zero.
  const shares = cols === 1 ? [0, 0.25, 0.5, 0.75, 1] : [0, 0.5, 1];
  for (let gr = 0; gr < gridRows; gr++) {
    const ay = bandTop(gr) + panelH + 6;
    for (let col = 0; col < cols; col++) {
      const p = panels[gr * cols + col];
      if (!p) break;
      // A panel with nothing drawn in it gets no ruler; there would be nothing to read
      // off it. Only the indicator reading reaches this, and it reaches it easily: maths
      // is published for both sexes only, so asking for male and female empties that
      // panel and would otherwise leave an axis under a column of "no data available".
      const ref = p.rows.flatMap((r) => r.tracks)[0];
      if (!ref) continue;
      const plotX = plotXOf(col);
      const [rlo, rhi] = p.domain(ref);
      svg.appendChild(el("line", {
        class: "axis-rule", x1: plotX, x2: plotX + plotW, y1: ay, y2: ay,
      }));
      const ticks = sharedScale
        ? niceTicks(rlo, rhi, cols === 1 ? 5 : 4).map((v) => [p.pos(ref, v), num(v)])
        : shares.map((q) => [p.pos(ref, rlo + q * (ref.goalpost - rlo)),
          `${Math.round(q * 100)}%`]);
      for (const [q, label] of ticks) {
        if (q == null || q < -0.01 || q > 1.01) continue;
        const x = plotX + q * plotW;
        svg.appendChild(el("line", { class: "axis-tick", x1: x, x2: x, y1: ay, y2: ay + 4 }));
        svg.appendChild(el("text", {
          class: "axis-label", x, y: ay + 16, "text-anchor": "middle",
        }, label));
      }
    }
  }

  if (axisTitle) {
    svg.appendChild(el("text", {
      class: "axis-title", x: labelW + (width - labelW) / 2, y: titleY,
      "text-anchor": "middle",
    }, axisTitle));
  }

  CHART_CFG.set(svg, sub);
  host.appendChild(svg);
  if (cfg.legend !== false) host.appendChild(prospectLegend(sub));
  optionsPanel(host).appendChild(tableView(panels, sub));
}

// The vintage, said once, as the label itself: "2025 value". Grouped by FAMILY, so three
// mortality rows do not take three entries.
//
// It used to read "latest value (2025; maths ~2025)". The tilde marked that SOME location
// somewhere ends earlier than the headline year — since PISA 2025 that is Uzbekistan alone,
// on 2022 — but latestYearMin is computed across every location rather than the ones on
// screen, so the tilde appeared even on a figure showing only countries whose maths really
// is 2025. It was warning about a row the reader could not see. The per-country year is in
// the table under every figure, which is where a reader checks one country.
//
// What the guard was actually for survives: if two families ever end in DIFFERENT years,
// they are still named separately, because a flat year printed over a row of another
// vintage is the error this text exists to prevent. That is dormant today — everything is
// 2025 — and would wake up the moment one source lags.
function vintageText(cfg) {
  const S = cfg.summary;
  const keys = cfg.mode === "locations" && cfg.outcome
    ? [cfg.outcome] : outcomeKeys(cfg);
  const seen = new Map();
  for (const k of keys) {
    const m = S.outcomes[k];
    if (!m || m.latestYear == null) continue;
    if (!seen.has(m.family ?? m.short)) {
      seen.set(m.family ?? m.short, `${m.period ?? m.latestYear}`);
    }
  }
  if (!seen.size) return "value";

  // The common year carries the label; only families that DIFFER are named after it. Not
  // hardcoded to 2025 — the year is read from the data every render.
  const tally = new Map();
  for (const y of seen.values()) tally.set(y, (tally.get(y) ?? 0) + 1);
  const common = [...tally].sort((a, b) => b[1] - a[1])[0][0];
  const odd = [...seen].filter(([, y]) => y !== common);
  if (!odd.length) return `${common} value`;
  return `${common} value (${odd.map(([name, y]) => `${name} ${y}`).join("; ")})`;
}

// What the legend says, as data. Both renderers below read it — the HTML legend on the
// page and the SVG one baked into a download — so the two cannot drift apart.
function legendGroups(cfg) {
  // A figure not built from rows, dots and arrows has to say what its own marks mean.
  // The distribution figures do: a curve and a threshold line have nothing to do with
  // latest values or projections, so they supply their own key rather than borrowing one
  // that would describe marks they never draw.
  // An empty list is a figure that needs no key at all, and gets none.
  if (cfg.legendItems) return cfg.legendItems.length ? [cfg.legendItems] : [];
  const sharedScale = cfg.mode === "locations" && cfg.rowScale !== "own";
  const seriesKeys = seriesKeysOf(cfg);
  const colorSeries = !sharedScale && seriesKeys.length > 1
    && seriesKeys.length <= SERIES.length;

  // A figure of outcomes measured once draws dots and nothing else, so a key describing
  // arrows and on-track colours would describe marks that are not on it.
  const keys = cfg.mode === "locations" && cfg.outcome ? [cfg.outcome] : outcomeKeys(cfg);
  if (keys.every((k) => cfg.summary.outcomes[k]?.singleObservation)) {
    return [[{ mark: "dot", label: vintageText(cfg) }]];
  }

  const groups = [[
    // Each entry draws its own mark beside the text, so naming the mark in the text too
    // ("arrow → …") said it twice and used a glyph the legend had already drawn.
    //
    // Not "projected". What this figure does is hold one measured rate constant for
    // twenty-five years; "projected" suggests a model with more in it than that, and
    // overstating the machinery is the one thing a figure about the future should not do.
    { mark: "dot", label: vintageText(cfg) },
    { mark: "arrow", fill: "currentColor",
      label: `${cfg.summary.meta.targetYear} value on recent trend` },
  ]];

  if (colorSeries) {
    groups.push(seriesKeys.map((k, i) => (
      { mark: "arrow", fill: SERIES[i], label: k, strong: true })));
  }

  // Status is named only where the ARROWS carry it. Where the background bands carry it
  // instead, the axis running under them already reads 0-100% of the gap and the band
  // edges fall on its 25% and 50% ticks, so a three-line key restating that is clutter
  // rather than a second channel. Worth knowing that this is a trade: on those figures
  // the colours have a positional reading rather than a written one.
  if (sharedScale) {
    groups.push(["critical", "warning", "good"].map((k) => (
      { mark: "arrow", fill: STATUS[k].fill, label: STATUS[k].label, hint: STATUS[k].hint,
        strong: true })));
  }
  return groups;
}

// The legend as it appears on the page.
export function prospectLegend(cfg) {
  const wrap = document.createElement("div");
  wrap.className = "prospect-legend";
  const tri = (fill) =>
    `<svg width="15" height="12" aria-hidden="true"><path d="M14 6 L3 1 L3 11 Z" fill="${fill}"/></svg>`;
  const dot =
    `<svg width="14" height="14" aria-hidden="true">`
    + `<circle cx="7" cy="7" r="4.5" class="mark-latest"></circle></svg>`;
  // A short upright stroke, for a figure whose mark IS a vertical rule. It takes the
  // threshold line's own class so it picks up the same dash and colour from site.css
  // rather than restating them here and drifting.
  const rule =
    `<svg width="15" height="12" aria-hidden="true">`
    + `<line x1="7.5" y1="0.5" x2="7.5" y2="11.5" class="dist-threshold"/></svg>`;
  // A highlighted country in a distribution: its tick, standing on its dot.
  const hl =
    `<svg width="15" height="12" aria-hidden="true">`
    + `<line x1="7.5" y1="0.5" x2="7.5" y2="9" class="dist-hl"/>`
    + `<circle cx="7.5" cy="9" r="2.5" class="dist-hl-dot"/></svg>`;
  const hlQuiet = hl.replace(/class="dist-hl(-dot)?"/g, (m) => m.replace(/"$/, ' quiet"'));

  for (const grp of legendGroups(cfg)) {
    const d = document.createElement("div");
    d.className = "legend-group";
    d.innerHTML = grp.map((it) => {
      const mark = it.mark === "dot" ? dot : it.mark === "rule" ? rule
        : it.mark === "hl" ? hl : it.mark === "hl-quiet" ? hlQuiet : tri(it.fill);
      const label = it.strong ? `<strong>${it.label}</strong>` : it.label;
      const hint = it.hint ? ` <span class="muted">${it.hint}</span>` : "";
      return `<span class="key">${mark}${label}${hint}</span>`;
    }).join("");
    wrap.appendChild(d);
  }
  return wrap;
}

// The same legend as SVG, laid out by MEASURING the text rather than estimating it —
// which is only possible because the caller has already parked the svg in the document.
// Returns the height it used.
function appendLegend(svg, cfg, offsetY) {
  const width = Number(svg.getAttribute("width"));
  const g = el("g", { class: "svg-legend" });
  svg.appendChild(g);

  const MARK = 15, GAP = 5, ITEM = 18, GROUP = 30, LINE = 17;
  let x = 0, y = 11;

  for (const grp of legendGroups(cfg)) {
    for (const it of grp) {
      const t = el("text", { class: "legend-label", "dominant-baseline": "middle" });
      t.appendChild(el("tspan", { class: it.strong ? "legend-strong" : null }, it.label));
      // The gap is a `dx`, not a leading space. librsvg strips whitespace that opens a
      // <tspan>, a no-break space included, which printed "Off trackcloses under a quarter"
      // in every figure that went through it.
      if (it.hint) t.appendChild(el("tspan", { class: "legend-hint", dx: 3.5 }, it.hint));
      g.appendChild(t);

      const w = t.getComputedTextLength();
      if (x > 0 && x + MARK + GAP + w > width) { x = 0; y += LINE; }
      t.setAttribute("x", x + MARK + GAP);
      t.setAttribute("y", y);

      if (it.mark === "dot") {
        g.appendChild(el("circle", { class: "mark-latest", cx: x + 7, cy: y, r: 4.5 }));
      } else if (it.mark === "rule") {
        g.appendChild(el("line", {
          class: "dist-threshold",
          x1: x + 7.5, y1: y - 6, x2: x + 7.5, y2: y + 6,
        }));
      } else if (it.mark === "hl" || it.mark === "hl-quiet") {
        const q = it.mark === "hl-quiet" ? " quiet" : "";
        g.appendChild(el("line", { class: `dist-hl${q}`, x1: x + 7.5, y1: y - 6, x2: x + 7.5, y2: y + 3 }));
        g.appendChild(el("circle", { class: `dist-hl-dot${q}`, cx: x + 7.5, cy: y + 3, r: 2.5 }));
      } else {
        g.appendChild(el("path", {
          class: "proj-arrow",
          d: `M ${x + 14} ${y} L ${x + 3} ${y - 5} L ${x + 3} ${y + 5} Z`,
          fill: it.fill === "currentColor" ? "var(--chart-mark)" : it.fill,
        }));
      }
      x += MARK + GAP + w + ITEM;
    }
    // Groups are separated by a wider gap, and start a new line rather than trailing off
    // the right edge.
    x += GROUP - ITEM;
    if (x > width * 0.7) { x = 0; y += LINE; }
  }

  g.setAttribute("transform", `translate(0, ${offsetY})`);
  return y + 8;
}

// Break a string into lines that fit `width`, by MEASURING rather than estimating. SVG has
// no text wrapping of its own and `textLength` only squeezes a single line, so a paragraph
// has to be laid out here or not at all. Real measurement rather than the 6.3px-a-character
// estimate the chart uses for its gutters: those are one short label each, this is nine
// sentences, where the error compounds into a line that runs off the page.
//
// The probe is a real <text> in the parked clone, so it picks up the same class, the same
// font and the same export theme the finished lines will have.
function wrapLines(svg, text, width, cls) {
  const probe = el("text", { class: cls, x: 0, y: -1000 });
  svg.appendChild(probe);
  const lines = [];
  let line = "";
  try {
    for (const word of String(text).split(/\s+/).filter(Boolean)) {
      const next = line ? `${line} ${word}` : word;
      probe.textContent = next;
      if (line && probe.getComputedTextLength() > width) { lines.push(line); line = word; }
      else line = next;
    }
  } finally {
    probe.remove();
  }
  if (line) lines.push(line);
  return lines;
}

// A block of wrapped text at `offsetY`, returning the height it used — same contract as
// appendLegend, so the caller can stack the three without knowing what is in any of them.
function appendTextBlock(svg, lines, cls, offsetY, lineH) {
  const g = el("g", { transform: `translate(0, ${offsetY})` });
  lines.forEach((t, i) => g.appendChild(el("text", { class: cls, x: 0, y: (i + 1) * lineH }, t)));
  svg.appendChild(g);
  return lines.length * lineH;
}

/**
 * A detached copy of a chart with its legend baked in, ready to serialize.
 *
 * The page draws the legend as HTML next to the chart — it wraps properly, it is
 * selectable, and several charts can share one. None of that survives a download, which
 * takes the <svg> and nothing else, so a saved figure used to arrive with no key at all.
 * This rebuilds it inside the SVG from the same description the page legend uses.
 *
 * `extras.title` and `extras.notes` are opt-in and default to absent, which is what the
 * figure has always downloaded as: the reader who is going to write their own caption in
 * Word wants neither. They go INSIDE the same <svg> rather than in a wrapper, because the
 * PNG path rasterizes this one element and anything outside it would not be in the image.
 */
// Lets a figure drawn elsewhere use this module's export path — the title above the
// plot, the legend and the notes rebuilt inside the SVG on the way out. Without it
// `exportSvg` finds no config and returns a bare clone, so the download would silently
// lose everything the page shows around the plot.
export function registerExportable(svg, cfg) {
  CHART_CFG.set(svg, cfg);
}

export function exportSvg(svg, extras = {}) {
  const cfg = CHART_CFG.get(svg);
  const clone = svg.cloneNode(true);
  if (!cfg) return clone;

  // Parked light, and parked at all: getComputedTextLength on a detached node returns 0,
  // silently, which would stack every legend item at x = 20 — and, now, wrap every
  // paragraph onto one endless line.
  const park = document.createElement("div");
  park.className = "figure-export-light";
  park.style.cssText = "position:absolute; left:-10000px; top:0;";
  park.appendChild(clone);
  document.body.appendChild(park);

  try {
    const width = Number(clone.getAttribute("width"));
    const height = Number(clone.getAttribute("height"));

    // The title goes ABOVE the plot, so everything already drawn has to move down. Moving
    // the existing children into one translated <g> is what does that without touching a
    // single coordinate the layout computed — and it has to happen before the legend and
    // the notes are appended, or they would be shifted too.
    let top = 0;
    if (extras.title) {
      const lines = wrapLines(clone, extras.title, width, "svg-figure-title");
      top = lines.length * 19 + 8;
      const body = el("g", { transform: `translate(0, ${top})` });
      while (clone.firstChild) body.appendChild(clone.firstChild);
      clone.appendChild(body);
      appendTextBlock(clone, lines, "svg-figure-title", 0, 19);
    }

    let y = top + height + 4;
    if (legendGroups(cfg).length) y += appendLegend(clone, cfg, y);
    if (extras.notes) {
      y += 6 + appendTextBlock(
        clone, wrapLines(clone, extras.notes, width, "svg-figure-note"),
        "svg-figure-note", y + 6, 15);
    }

    clone.setAttribute("height", y);
    clone.setAttribute("viewBox", `0 0 ${width} ${y}`);
  } finally {
    park.remove();
  }
  return clone;
}

// Table twin — every value reachable without hovering anything. Panelled the same way
// the chart is, so the two always say the same thing about which group a row is in.
function tableView(panels, cfg) {
  const S = cfg.summary;
  const d = document.createElement("details");
  d.className = "prospect-table";
  d.innerHTML = "<summary>View as table</summary>";

  const t = document.createElement("table");
  // The first column is whatever the ROWS are, which is the opposite of what the panels
  // are: indicators down a location's panel, locations down an indicator's.
  t.innerHTML =
    `<thead><tr><th>${cfg.mode === "outcomes" ? "Indicator" : "Location"}</th>` +
    `<th>Sex</th><th>Trend</th>` +
    `<th class="num">Latest</th><th class="num">Projected ${S.meta.targetYear}</th>` +
    `<th class="num">Gap closed</th><th>Status</th></tr></thead>`;
  const tb = document.createElement("tbody");

  const add = (html, cls) => {
    const tr = document.createElement("tr");
    if (cls) tr.className = cls;
    tr.innerHTML = html;
    tb.appendChild(tr);
  };

  for (const p of panels) {
    // The unit rides with the heading where the panel IS an indicator, for the same
    // reason it does on the chart.
    if (p.label) {
      add(`<th colspan="7">${p.label}${p.sublabel ? `, ${p.sublabel}` : ""}</th>`,
        "panel-row");
    }

    for (const r of p.rows) {
      const name = cfg.mode === "outcomes" ? fullName(r.meta) : r.label;
      if (!r.tracks.length) {
        add(`<td>${name}</td><td colspan="6" class="muted">no data available</td>`);
        continue;
      }
      for (const tk of r.tracks) {
        const latest = `${num(tk.latest)} <span class="muted">(${tk.latestYear})</span>`;
        if (!tk.projections.length) {
          add(`<td>${name}</td><td>${SEX_LONG[tk.sex]}</td>` +
            `<td class="muted">no trend</td><td class="num">${latest}</td>` +
            `<td class="num">–</td><td class="num">–</td><td>–</td>`);
          continue;
        }
        for (const pr of tk.projections) {
          const st = statusOf(pr.pct, S.meta.bands);
          add(`<td>${name}</td><td>${SEX_LONG[tk.sex]}</td>` +
            `<td>${windowLabel(pr.window)} <span class="muted">(${pr.from}–${pr.to})</span></td>` +
            `<td class="num">${latest}</td>` +
            `<td class="num">${num(pr.proj)}</td>` +
            `<td class="num">${pr.pct == null ? "–" : Math.round(pr.pct * 100) + "%"}</td>` +
            `<td>${st ? STATUS[st].label : "–"}</td>`);
        }
      }
    }
  }
  t.appendChild(tb);
  d.appendChild(t);
  return d;
}
