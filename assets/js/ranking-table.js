// Every country on one indicator, ranked — the league table the three chart sections
// cannot be, because a chart with two hundred rows is a wall.
//
// The column that is not in any other figure is **years to the goal**: how long this
// country would need, at the pace it is currently moving, to close half its gap. That is
// the same target the 2050 figures colour by, read as a duration rather than as a verdict,
// which is what makes "off track" mean something specific — 40 years rather than 25.
//
// Countries only, like the distribution figures: a regional aggregate is a weighted mean
// of countries already in the table and would rank among its own members.

import { num, fullName } from "./format.js";

// One row's worth of arithmetic. `rate` reads against the outcome's own rule, so the two
// branches are the same two the pipeline projects with.
//
// The goal is *half the gap*, not the goalpost itself. Reaching the goalpost is infinitely
// far away for anything compounding on its gap, so a "years to zero mortality" column
// would read "never" for all two hundred and say nothing.
function yearsToGoal(meta, rate, sex, band) {
  if (rate == null || !Number.isFinite(rate)) return null;
  if (meta.trendRule === "linear") {
    const target = meta.target?.[sex];
    return target != null && rate > 0 ? target / rate : null;
  }
  // gap(t) = gap0 (1+r)^t, so t = ln(1-band) / ln(1+r); defined only while the gap shrinks.
  return rate < 0 ? Math.log(1 - band) / Math.log(1 + rate) : null;
}

// Ranked best-first by default, and "best" is direction-dependent: falling fastest for the
// four that aim at zero, rising fastest for height. Sorting on the raw rate would put
// height's leaders at the bottom.
const COLUMNS = [
  { key: "label", label: "Country", num: false },
  // Improvement, not change: a falling mortality rate is the good news, and printing it as
  // -4% made every leader in the table look like a loss. The sign is flipped HERE, at
  // display, for the lower-is-better outcomes; `rate` in summary.json keeps its own sign,
  // because key-numbers.csv and the manuscript read it (2026-09-25 meeting).
  { key: "rate", label: "Average annual rate of improvement", num: true },
  { key: "latest", label: null, num: true },        // filled in with its own year
  { key: "proj", label: null, num: true },          // filled in with the target year
  { key: "years", label: "Years to the goal", num: true },
];

export function rankingTable(host, cfg) {
  const { summary: S, locations: L, outcome, sex, window: w, sortBy, sortDir, onSort } = cfg;
  const meta = S.outcomes[outcome];
  const F = S.meta.trendFields;
  const iRate = F.indexOf("rate");
  const iProj = F.indexOf("proj2050");
  const band = S.meta.bands[1];
  const asPct = meta.trendRule !== "linear";
  const better = meta.direction === "higher" ? 1 : -1;

  host.textContent = "";

  const rows = [];
  for (const [code, byo] of Object.entries(S.data)) {
    if (L.locations[code]?.type !== "country") continue;
    const rec = byo?.[outcome]?.[sex];
    if (!rec) continue;
    const t = rec.t?.[w];
    const rate = t ? t[iRate] : null;
    rows.push({
      code, label: L.locations[code].label,
      latest: rec.v, latestYear: rec.y,
      rate,
      proj: t ? t[iProj] : null,
      years: yearsToGoal(meta, rate, sex, band),
      // Wrong way is not the same as "slow": it is why the years column is empty, and the
      // row has to say which of the two it is.
      wrongWay: rate != null && Number.isFinite(rate) && rate !== 0
        && Math.sign(rate) !== better,
    });
  }

  if (!rows.length) {
    const p = document.createElement("p");
    p.className = "note fig-empty";
    p.textContent = "No country has a trend for this indicator on this window.";
    host.appendChild(p);
    return { rows, meta };
  }

  // Missing values sort last whichever way the column is pointing, so a click never
  // fills the top of the table with blanks.
  const dir = sortDir ?? (sortBy === "label" ? 1 : -1);
  const val = (r) => (sortBy === "rate" ? (r.rate == null ? null : r.rate * better) : r[sortBy]);
  rows.sort((a, b) => {
    const [x, y] = [val(a), val(b)];
    if (x == null && y == null) return a.label.localeCompare(b.label);
    if (x == null) return 1;
    if (y == null) return -1;
    return (typeof x === "string" ? x.localeCompare(y) : x - y) * dir;
  });

  const cols = COLUMNS.map((c) => ({
    ...c,
    label: c.label ?? (c.key === "latest"
      ? `Value (${meta.latestYear})`
      : `${S.meta.targetYear} on this trend`),
  }));

  const table = document.createElement("table");
  table.innerHTML = `<thead><tr><th class="num rank">#</th>${cols.map((c) =>
    `<th class="${c.num ? "num " : ""}sortable${sortBy === c.key ? " sorted" : ""}"
         data-col="${c.key}" tabindex="0" role="button"
         aria-sort="${sortBy === c.key ? (dir === 1 ? "ascending" : "descending") : "none"}"
      >${c.label}${sortBy === c.key ? (dir === 1 ? " ▲" : " ▼") : ""}</th>`).join("")}</tr></thead>`;

  const unit = asPct ? "%" : ` ${meta.unit}`;
  const tb = document.createElement("tbody");
  rows.forEach((r, i) => {
    const tr = document.createElement("tr");
    const imp = r.rate == null ? null : r.rate * better;
    const rate = imp == null ? "–"
      : `${imp > 0 ? "+" : ""}${num(asPct ? imp * 100 : imp)}${unit}`;
    // Whole years: the site's 1-10 rule would print "3.0", a precision this number does
    // not have, being a duration read off a decade-long trend. And three different
    // empties below, because they do not mean the same thing.
    const years = r.years != null ? String(Math.round(r.years))
      : r.wrongWay ? `<span class="wrong">moving away</span>`
        : r.rate == null ? "–" : `<span class="muted">no change</span>`;
    tr.innerHTML =
      `<td class="num rank">${i + 1}</td>`
      + `<th scope="row">${r.label}</th>`
      + `<td class="num${r.wrongWay ? " wrong" : ""}">${rate}</td>`
      + `<td class="num">${num(r.latest)}</td>`
      + `<td class="num">${r.proj == null ? "–" : num(r.proj)}</td>`
      + `<td class="num">${years}</td>`;
    tb.appendChild(tr);
  });
  table.appendChild(tb);

  const scroll = document.createElement("div");
  scroll.className = "rank-scroll";
  scroll.appendChild(table);
  host.appendChild(scroll);

  const sort = (th) => onSort(th.dataset.col);
  table.querySelectorAll("th.sortable").forEach((th) => {
    th.addEventListener("click", () => sort(th));
    th.addEventListener("keydown", (e) => {
      if (e.key === "Enter" || e.key === " ") { e.preventDefault(); sort(th); }
    });
  });

  return { rows, meta };
}
