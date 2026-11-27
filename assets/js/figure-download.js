// The download control that sits under a figure.
//
// The point of it is that a reader who wants a figure in a report should get one
// without writing code. Two formats, because they answer two different questions:
// SVG is vector and stays sharp at any size — Word, PowerPoint and Illustrator
// all take it directly, and it is what a journal wants. PNG is for anything that
// cannot read SVG.
//
// The image is deliberately plot-only: no title, no caption. Those belong in the
// document, where they can be edited and restyled without coming back here.

import { serializeStandaloneSvg, svgToPngBlob, saveBlob } from "./svg-standalone.js";
import { exportSvg } from "./prospect-chart.js";
import { FORMATS, drawForFormat } from "./figure-format.js";

// Dates in filenames are what stop a folder of downloads becoming
// figure(1).svg, figure(2).svg. Local date, not ISO UTC — a figure saved late in
// the evening should not be stamped tomorrow.
function today() {
  const d = new Date();
  return [
    d.getFullYear(),
    String(d.getMonth() + 1).padStart(2, "0"),
    String(d.getDate()).padStart(2, "0"),
  ].join("-");
}

function slug(text) {
  return String(text)
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-|-$/g, "")
    .slice(0, 60);
}

/**
 * Append a download control to `host`.
 *
 * One format picker rather than a button per format: the two are alternatives, and a row
 * of buttons said otherwise. The title and the notes are opt-in tick boxes, unticked, so
 * the default download is the plot alone — which is what it has always been, and what the
 * reader writing their own caption in Word wants.
 *
 * A second picker says where the figure is going — an A4 page (the default) or a 16:9
 * slide — and the figure is drawn again for that, off-screen, rather than copied off the
 * screen (figure-format.js). That also makes a download the same whatever window it was
 * saved from, which it was not while it was a copy of the chart as drawn.
 *
 * @param {Element}  host      where the control goes, usually just after the chart
 * @param {Function} getSvg    returns the current <svg>. A function, not the node:
 *                             every re-render replaces it, and a captured
 *                             reference would quietly export a stale figure.
 * @param {Function} getName   returns a human description used for the filename
 * @param {Function} [getText] returns { title, notes } for this figure AS IT IS NOW —
 *                             read at click time for the same reason as the svg
 * @param {object}   [layout]  { draw, maxCols }: `draw(host, overrides)` draws this figure
 *                             into another host, and `maxCols` is its panel count (omit for
 *                             a figure that is not a grid). Without it the download is the
 *                             figure as it is on screen, whatever the second picker says.
 */
export function figureDownload(host, getSvg, getName, getText, layout) {
  const wrap = document.createElement("div");
  wrap.className = "fig-download";

  const label = document.createElement("span");
  label.className = "fig-download-label";
  label.textContent = "Download figure";
  wrap.appendChild(label);

  const format = document.createElement("select");
  format.setAttribute("aria-label", "File format");
  // SVG first, and therefore the default. It is vector — Word, PowerPoint and Illustrator
  // all insert it directly and it stays sharp at any size, which is what a journal wants.
  // PNG is the fallback for anything that cannot read SVG.
  for (const [value, text] of [["svg", "SVG"], ["png", "PNG"]]) {
    format.appendChild(new Option(text, value));
  }
  wrap.appendChild(format);

  // Print first, and therefore the default: a download has always been sized for a page,
  // and the paper's figures are the ones this control exists for.
  const target = document.createElement("select");
  target.setAttribute("aria-label", "Lay out for");
  for (const [value, f] of Object.entries(FORMATS)) {
    target.appendChild(new Option(f.label, value));
  }
  if (layout) wrap.appendChild(target);

  const parts = {};
  for (const [key, text] of [["title", "Include title"], ["notes", "Include notes"]]) {
    const opt = document.createElement("label");
    opt.className = "fig-download-opt";
    const box = document.createElement("input");
    box.type = "checkbox";
    opt.append(box, document.createTextNode(` ${text}`));
    wrap.appendChild(opt);
    parts[key] = box;
  }

  const button = document.createElement("button");
  button.type = "button";
  button.className = "chip";
  button.textContent = "Download";
  wrap.appendChild(button);

  const status = document.createElement("span");
  status.className = "fig-download-status";
  status.setAttribute("role", "status");
  wrap.appendChild(status);

  button.addEventListener("click", async () => {
    const svg = getSvg();
    if (!svg) {
      status.textContent = "Nothing to download yet.";
      return;
    }

    // PNG rasterization is fast but not instant on a large figure, and a button
    // that looks inert is a button people press again.
    button.disabled = true;
    button.textContent = "Working…";
    status.textContent = "";

    try {
      const ext = format.value;
      // Named for the slide only, so a print download keeps the filename it always had and
      // the two versions of one figure do not overwrite each other in a downloads folder.
      const where = layout && target.value !== "print" ? `-${target.value}` : "";
      const name = `${slug(getName())}${where}-${today()}.${ext}`;
      const text = (parts.title.checked || parts.notes.checked) && getText ? getText() : {};
      const extras = {
        title: parts.title.checked ? text.title : null,
        notes: parts.notes.checked ? text.notes : null,
      };
      // Not the chart on the page: a detached copy carrying its legend, and whatever the
      // tick boxes asked for. The page draws the legend as HTML beside the chart, so a
      // download of the <svg> alone used to arrive with no key on it.
      const out = (layout && drawForFormat(layout.draw, target.value, extras, layout.maxCols))
        ?? exportSvg(svg, extras);

      if (ext === "svg") {
        saveBlob(new Blob([serializeStandaloneSvg(out)], { type: "image/svg+xml" }), name);
      } else {
        saveBlob(await svgToPngBlob(out), name);
      }

      status.textContent = `Saved ${name}`;
    } catch (err) {
      status.textContent = `Could not save the figure: ${err.message}`;
    } finally {
      button.disabled = false;
      button.textContent = "Download";
    }
  });

  host.appendChild(wrap);
  return wrap;
}
