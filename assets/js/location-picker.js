// Searchable, multi-select location tree.
//
// Two ways in, because people arrive knowing different things: type a name and pick
// it from the filtered list, or browse continents and tick boxes. Selections show as
// removable chips so the current set is always visible without opening the tree.
//
// Shared across the site — the same picker is meant to drive every tool
// (ARCHITECTURE.md, ADR-008), so it owns no page-specific behaviour and just emits
// "change" with the current array of codes.

const AGG = "Regions & income groups";

// Aggregates used to land in one 53-row bucket under AGG, which is four different
// classification schemes stacked on top of each other. They are split by the scheme each
// code already names — locations.json carries it, inherited from IGME's own
// `regional_group` — so nothing here is invented.
//
// UNICEF gets TWO groups because it publishes two overlapping sets and IGME ships both:
// seven regional offices (…RO, plus ROSA) and eleven reporting regions. **Four of the
// seven near-duplicate pairs carry different numbers** — UNICEF_ECA neonatal is 4.05
// against UNICEF_ECARO's 6.55 — while sharing a label to the character. One flat list of
// two identical "Europe and Central Asia" entries is a trap, so they are separated here
// and disambiguated by code below.
//
// UNSDG mixes geography with membership lists; "Least developed countries" is not a
// region and does not belong under a heading that says it is.
const UNSDG_GROUPINGS = new Set(["UNSDG_LDC", "UNSDG_LLDC", "UNSDG_SIDS"]);
const UNICEF_OFFICES = /^(UNICEF_.*RO|UNICEF_ROSA)$/;

const AGG_GROUPS = [
  ["World", (c) => c === "WORLD"],
  ["Global Health 2050 regions", (c) => c.startsWith("CIH_")],
  ["World Bank income groups", (c) => c.startsWith("WB_")],
  ["UNICEF regions (regional offices)", (c) => UNICEF_OFFICES.test(c)],
  ["UNICEF reporting regions", (c) => c.startsWith("UNICEF_")],
  ["UN SDG regions", (c) => c.startsWith("UNSDG_") && !UNSDG_GROUPINGS.has(c)],
  ["UN SDG country groupings", (c) => UNSDG_GROUPINGS.has(c)],
];

// The group an aggregate belongs to, or the old catch-all for a scheme nobody has
// taught this file about — a new prefix should be filed oddly, never dropped.
const aggGroup = (code) => (AGG_GROUPS.find(([, test]) => test(code)) ?? [AGG])[0];

export function locationPicker(host, locations, initial, onChange) {
  const codes = Object.keys(locations);
  const selected = new Set(initial.filter((c) => locations[c]));

  // Countries group by continent; IGME's aggregates have no continent, so they get
  // their own group at the end rather than being dropped.
  // Where two locations share a label the code is shown beside the name. Computed from
  // what is loaded rather than listed, so it appears only where there is a real collision.
  //
  // Two kinds of collision, and the second is why the whole code is shown rather than the
  // part after the underscore: UNICEF's two sets collide with each other (two "Europe and
  // Central Asia" carrying different numbers), and CIH's single-country regions collide
  // with the countries themselves ("China" is both CHN and CIH_CHN). Stripping the scheme
  // prefix would then leave UNICEF_LAC and CIH_LAC both reading "(LAC)", which resolves
  // nothing. Counting spans every location for the same reason.
  const labelCount = new Map();
  for (const c of codes) {
    labelCount.set(locations[c].label, (labelCount.get(locations[c].label) ?? 0) + 1);
  }
  const displayLabel = (c) => {
    const { label, type } = locations[c];
    // The country keeps the plain name and the aggregate is the one that qualifies
    // itself: "China" is a country first, and CIH_CHN is a region that happens to be one.
    if (type !== "aggregate" || labelCount.get(label) < 2) return label;
    return `${label} (${c})`;
  };

  const groups = new Map();
  for (const c of codes.sort((a, b) => locations[a].label.localeCompare(locations[b].label))) {
    const g = locations[c].type === "aggregate" ? aggGroup(c) : (locations[c].region || "Other");
    if (!groups.has(g)) groups.set(g, []);
    groups.get(g).push(c);
  }

  // Continents first, alphabetically, then the aggregate groups in AGG_GROUPS order —
  // World, then the ten CIH regions this project uses, then the other schemes. Sorting
  // those alphabetically would put "Global Health 2050" above "World Bank" and below
  // "UN SDG", which is an ordering by spelling rather than by what a reader wants first.
  const aggOrder = [...AGG_GROUPS.map(([name]) => name), AGG];
  const order = [...groups.keys()].sort((a, b) => {
    const ia = aggOrder.indexOf(a), ib = aggOrder.indexOf(b);
    if (ia === -1 && ib === -1) return a.localeCompare(b);
    return ia === -1 ? -1 : ib === -1 ? 1 : ia - ib;
  });

  // Search and tree live inside one collapsed disclosure, so the resting state is a
  // single line and the figures start near the top of the page. The chips stay outside
  // it: what is currently selected has to be readable without opening anything.
  host.className = "locpicker";
  host.innerHTML =
    `<div class="chips" role="list"></div>
     <details class="loc-browse">
       <summary><span>Search or browse <span class="all-count">${codes.length}</span> locations</span></summary>
       <div class="panel">
         <input class="search" type="search" placeholder="Search countries and regions…"
                aria-label="Search locations" autocomplete="off" />
         <div class="tree"></div>
         <p class="tree-empty" hidden>No location matches that search.</p>
       </div>
     </details>`;

  const chips = host.querySelector(".chips");
  const browse = host.querySelector(".loc-browse");
  const search = host.querySelector(".search");
  const tree = host.querySelector(".tree");
  const empty = host.querySelector(".tree-empty");

  // Opening is a request to pick something, so put the cursor where picking starts.
  browse.addEventListener("toggle", () => { if (browse.open) search.focus(); });

  for (const g of order) {
    const d = document.createElement("details");
    d.className = "loc-group";
    d.innerHTML = `<summary>${g} <span class="count">${groups.get(g).length}</span></summary>`;
    const list = document.createElement("div");
    list.className = "loc-list";
    for (const c of groups.get(g)) {
      const lab = document.createElement("label");
      lab.className = "loc";
      lab.dataset.code = c;
      lab.dataset.search = locations[c].label.toLowerCase() + " " + c.toLowerCase();
      lab.innerHTML = `<input type="checkbox" value="${c}" /> <span>${displayLabel(c)}</span>`;
      list.appendChild(lab);
    }
    d.appendChild(list);
    tree.appendChild(d);
  }

  function emit() {
    onChange([...selected]);
  }

  function paintChips() {
    chips.innerHTML = "";
    if (!selected.size) {
      chips.innerHTML = `<span class="chips-empty">No locations selected</span>`;
      return;
    }
    for (const c of selected) {
      const b = document.createElement("button");
      b.type = "button";
      b.className = "chip";
      b.innerHTML = `${locations[c].label}<span aria-hidden="true">×</span>`;
      b.title = `Remove ${locations[c].label}`;
      b.addEventListener("click", () => {
        selected.delete(c);
        syncBoxes();
        paintChips();
        emit();
      });
      chips.appendChild(b);
    }
  }

  function syncBoxes() {
    for (const box of tree.querySelectorAll("input[type=checkbox]")) {
      box.checked = selected.has(box.value);
    }
  }

  tree.addEventListener("change", (e) => {
    const box = e.target;
    if (box.checked) selected.add(box.value); else selected.delete(box.value);
    paintChips();
    emit();
  });

  // Typing filters the whole tree and opens the groups that still have matches, so a
  // search never leaves the reader looking at collapsed headings.
  search.addEventListener("input", () => {
    const q = search.value.trim().toLowerCase();
    let total = 0;
    for (const d of tree.querySelectorAll(".loc-group")) {
      let shown = 0;
      for (const lab of d.querySelectorAll(".loc")) {
        const hit = !q || lab.dataset.search.includes(q);
        lab.hidden = !hit;
        if (hit) shown++;
      }
      d.hidden = shown === 0;
      d.querySelector(".count").textContent = shown;
      if (q) d.open = true;
      total += shown;
    }
    // A search that matches nothing must say so, not just leave an empty box.
    host.querySelector(".all-count").textContent = total;
    empty.hidden = total > 0;
  });

  syncBoxes();
  paintChips();

  return {
    get: () => [...selected],
    set(next) {
      selected.clear();
      for (const c of next) if (locations[c]) selected.add(c);
      syncBoxes();
      paintChips();
    },
  };
}
