// The disclosure that holds everything a reader does WITH a figure, as opposed to
// everything that changes what the figure shows.
//
// Those are two different questions and they were being answered in three places: a
// "Customize" panel above the chart, then a loose "View as table" toggle and a
// "Download figure" row stacked under it, then the "Notes" disclosure under that. Four
// controls in a column, three of them competing for the same glance. The table and the
// download belong together — both are ways of taking the figure away — so they go behind
// one summary and the space under a chart goes back to being quiet.
//
// Not called "Options": "Customize" already occupies that meaning on this page, above the
// figure, and two disclosures a few hundred pixels apart both promising options is worse
// than either name on its own. This one says what is actually inside it.
const LABEL = "Data and download";

/**
 * Find, or create, the options disclosure inside `host` and return the panel to put
 * controls into.
 *
 * Find-or-create rather than create: the table and the download control are appended by
 * different callers — the chart module owns the table, the page owns the download — and
 * making the second caller reuse the first one's panel is what keeps them in one
 * disclosure without either having to know about the other.
 *
 * Scoped to direct children. A grid figure has panels inside it that may carry their own
 * markup, and a loose querySelector would reach down into one and hang the page's
 * download control off a panel three levels in.
 *
 * @param {Element} host  the element the disclosure belongs to, usually the chart host
 * @returns {Element} the panel div, ready to append into
 */
export function optionsPanel(host) {
  let d = host.querySelector(":scope > details.fig-options");
  if (!d) {
    d = document.createElement("details");
    d.className = "fig-options small";
    const summary = document.createElement("summary");
    summary.textContent = LABEL;
    const panel = document.createElement("div");
    panel.className = "panel";
    d.append(summary, panel);
    host.appendChild(d);
  }
  return d.querySelector(":scope > .panel");
}
