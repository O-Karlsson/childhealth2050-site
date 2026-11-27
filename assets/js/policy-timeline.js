// policy-timeline.js — a policy episode against time, optionally over an indicator.
//
// THE DESIGN RULE (ADR-018). Policy events are drawn on their OWN TRACK BENEATH the
// chart, sharing its x-axis. They are never overlaid on the data ink. A vertical rule
// through a falling mortality curve asserts causation visually no matter what the
// caption says, and the CPI records explicitly decline to make that claim — CPI-002
// §7.3 ("does not treat national trends as program effects") and CPI-003 §7 ("should
// not automatically be translated into an attributable reduction"). A separate track
// lets the eye associate the two without the visual grammar claiming anything.
//
// The second half of the rule is carried by `value.role`:
//   "target"   the episode set out to move this  → drawn in ink, target mark allowed
//   "context"  background that moved anyway      → drawn GREY, labelled, no target mark
//
// Milestones are numbered ticks, spelled out in a list beneath the figure. Labels on
// the ticks themselves collide past about four events, and these episodes have nine.
//
// Sizing follows prospect-chart.js: width comes from host.clientWidth, which is ZERO
// inside a closed <details> — render on open, not on load (see ARCHITECTURE).

import { num } from "./format.js";

const NS = "http://www.w3.org/2000/svg";

const MILESTONE = {
  policy:    { fill: "var(--chart-mark)",  label: "Policy action" },
  milestone: { fill: "var(--series-3)",    label: "Milestone reached" },
  setback:   { fill: "#d03b3b",            label: "Setback" },
  context:   { fill: "var(--chart-muted)", label: "Context" },
};

const EPISODE_HUE = ["var(--series-1)", "var(--series-2)", "var(--series-3)"];

function el(tag, attrs = {}, text) {
  const n = document.createElementNS(NS, tag);
  for (const [k, v] of Object.entries(attrs)) if (v != null) n.setAttribute(k, v);
  if (text != null) n.textContent = text;
  return n;
}

// A year plus optional month as a fractional year, so an October event sits where it
// belongs rather than on the January gridline.
const at = (m) => m.year + (m.month ? (m.month - 1) / 12 : 0);

// Round a max up to something a human would pick for the top gridline.
function niceMax(v) {
  if (v <= 0) return 1;
  const mag = 10 ** Math.floor(Math.log10(v));
  for (const step of [1, 1.5, 2, 2.5, 3, 4, 5, 7.5, 10]) {
    if (v <= step * mag) return step * mag;
  }
  return 10 * mag;
}

/**
 * @param {HTMLElement} host
 * @param {{
 *   domain: [number, number],
 *   value?: { label, unit, source, role: "target"|"context", points: {year, v}[] },
 *   episodes: { id, title, from, to, milestones?: {year, month?, label, kind}[] }[]
 * }} opts
 */
export function renderPolicyTimeline(host, opts) {
  const { domain, value, episodes } = opts;
  host.textContent = "";

  const W = Math.max(320, Math.min(host.clientWidth || 720, 720));
  const M = { top: 12, right: 14, bottom: 26, left: value ? 42 : 14 };
  const valueH = value ? 132 : 0;
  const rowH = 46;                                  // title, then the bar, with room to lift
  const trackH = episodes.length * rowH;
  const H = M.top + valueH + (value ? 14 : 0) + trackH + M.bottom;

  const innerW = W - M.left - M.right;
  const [y0, y1] = domain;
  const x = (yr) => M.left + ((yr - y0) / (y1 - y0)) * innerW;

  const svg = el("svg", {
    class: "policy-svg", viewBox: `0 0 ${W} ${H}`, width: W, height: H,
    role: "img", "aria-label": opts.ariaLabel || "Policy episode timeline",
  });

  // --- the indicator, if one was given -----------------------------------------
  if (value) {
    // Zero-baselined, always. A truncated axis manufactures a visual trend, and a
    // manufactured trend sitting directly above a policy band is exactly the false
    // impression ADR-018 exists to prevent. Nigeria's neonatal mortality really is
    // near-flat across 2009–2022, and the figure should say so.
    const pts = value.points.filter((p) => Number.isFinite(p.v));
    const vMax = niceMax(Math.max(...pts.map((p) => p.v)));
    const vy = (v) => M.top + valueH - (v / vMax) * valueH;
    const context = value.role === "context";
    const ink = context ? "var(--chart-muted)" : "var(--chart-mark)";

    for (const t of [0, vMax / 2, vMax]) {
      svg.append(el("line", {
        class: "grid", x1: M.left, x2: W - M.right, y1: vy(t), y2: vy(t),
      }));
      svg.append(el("text", {
        class: "axis-label", x: M.left - 6, y: vy(t) + 4, "text-anchor": "end",
      }, num(t)));
    }

    svg.append(el("path", {
      class: "value-line", fill: "none", stroke: ink,
      "stroke-dasharray": context ? "4 3" : null,
      d: pts.map((p, i) => `${i ? "L" : "M"}${x(p.year).toFixed(1)},${vy(p.v).toFixed(1)}`).join(""),
    }));
    for (const p of pts) {
      const dot = el("circle", { class: "value-dot", cx: x(p.year), cy: vy(p.v), r: 2.8, fill: ink });
      dot.append(el("title", {}, `${p.year}: ${num(p.v)} ${value.unit}`));
      svg.append(dot);
    }

    const cap = el("text", { class: "value-label", x: M.left, y: M.top - 2 });
    cap.append(el("tspan", {}, value.label));
    if (context) cap.append(el("tspan", { class: "context-tag", dx: 6 }, "· context, not a programme effect"));
    svg.append(cap);
  }

  // --- the policy track ---------------------------------------------------------
  const trackTop = M.top + valueH + (value ? 14 : 0);
  let n = 0;                                        // milestone numbering, across rows
  const keyed = [];

  episodes.forEach((ep, i) => {
    const top = trackTop + i * rowH;
    const barY = top + 30;
    const hue = EPISODE_HUE[i % EPISODE_HUE.length];

    // Anchored at the plot's left edge, not at the bar start: a late-starting episode
    // would push a long title off the right edge on a narrow screen, and SVG text does
    // not wrap or ellipsize. Rows also scan better sharing one left edge.
    svg.append(el("text", { class: "ep-title", x: M.left, y: top + 10 }, ep.title));

    // A period is a span of whole years, so 2012–2020 runs to the END of 2020 — which
    // is where an August-2020 milestone has to land to read as "inside the episode".
    const bar = el("rect", {
      class: "ep-bar", x: x(ep.from), y: barY, rx: 5,
      width: Math.max(6, x(ep.to + 1) - x(ep.from)), height: 10, fill: hue,
    });
    bar.append(el("title", {}, `${ep.title}: ${ep.from}–${ep.to}`));
    svg.append(bar);

    // Events a few months apart collide at this scale (Oct 2012 and Jan 2013 are ~10px
    // apart on a 12-year span). Nudge each colliding marker onto an alternating row
    // rather than dropping or merging it — every event stays clickable and numbered.
    let prevX = -Infinity, lift = 0;
    for (const m of ep.milestones || []) {
      n += 1;
      const mx = x(at(m));
      lift = mx - prevX < 14 ? (lift === 0 ? -13 : 0) : 0;
      prevX = mx;
      const kind = MILESTONE[m.kind] || MILESTONE.policy;
      const g = el("g", { class: "ep-milestone" });
      if (lift) g.append(el("line", {
        class: "ep-stem", x1: mx, x2: mx, y1: barY + 5 + lift, y2: barY + 5, stroke: kind.fill,
      }));
      g.append(el("circle", { cx: mx, cy: barY + 5 + lift, r: 6.5, fill: kind.fill }));
      g.append(el("text", {
        class: "ep-milestone-n", x: mx, y: barY + 8.5 + lift, "text-anchor": "middle",
      }, String(n)));
      g.append(el("title", {}, `${m.year}: ${m.label}`));
      svg.append(g);
      keyed.push({ n, kind: m.kind, ...m });
    }
  });

  // --- year axis, shared by both halves -----------------------------------------
  const axisY = trackTop + trackH + 4;
  svg.append(el("line", { class: "axis-rule", x1: M.left, x2: W - M.right, y1: axisY, y2: axisY }));
  const span = y1 - y0;
  const step = span <= 12 ? 2 : span <= 30 ? 5 : 10;
  for (let yr = Math.ceil(y0 / step) * step; yr <= y1; yr += step) {
    svg.append(el("line", { class: "axis-tick", x1: x(yr), x2: x(yr), y1: axisY, y2: axisY + 4 }));
    svg.append(el("text", { class: "axis-label", x: x(yr), y: axisY + 16, "text-anchor": "middle" }, String(yr)));
  }

  host.append(svg);

  // --- the numbered key ---------------------------------------------------------
  if (keyed.length) {
    const ol = document.createElement("ol");
    ol.className = "policy-key";
    for (const m of keyed) {
      const li = document.createElement("li");
      li.value = m.n;
      const swatch = document.createElement("span");
      swatch.className = "dot";
      swatch.style.background = (MILESTONE[m.kind] || MILESTONE.policy).fill;
      li.append(swatch, `${m.year} — ${m.label}`);
      ol.append(li);
    }
    host.append(ol);
  }

  if (value) {
    const p = document.createElement("p");
    p.className = "policy-source";
    p.textContent = value.role === "context"
      ? `${value.label}. Shown as background only — the episode does not claim to have moved it. Source: ${value.source}.`
      : `${value.label}. Source: ${value.source}.`;
    host.append(p);
  }
}
