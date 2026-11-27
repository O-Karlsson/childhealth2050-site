// Laying a downloaded figure out for where it is going: an A4 page or a 16:9 slide.
//
// The page draws each chart to fit the reader's window, which is the right shape for nobody
// else. A figure going onto A4 wants roughly a text column's width; one going onto a slide
// wants to be wide and short. Neither comes from scaling the on-screen picture, because
// scaling carries the text with it — a tall grid shrunk to fit a slide arrives with six-point
// labels. What CAN change is the layout: how wide the chart is drawn and, for the grids, how
// many panels sit side by side. So the figure is drawn again off-screen for each candidate,
// and the one kept is the one whose text comes out largest once the whole figure is scaled
// into the box.
//
// Text size is the right thing to maximise because nothing in these charts measures text:
// every label is a fixed pixel size and every gutter a fixed pixel width. The factor that
// fits a figure to the box is therefore exactly the factor its labels print at.

import { exportSvg } from "./prospect-chart.js";

// The area each figure should fill, in inches.
//
//   print  An A4 portrait text block with 2.5 cm margins (16 cm wide), less room for a
//          caption. Drawn at 720px only: the width the site caps a single chart at and the
//          one the paper's own figure pipeline uses, so labels land at about 7.5pt — a
//          journal's size — and a figure saved from a phone matches one saved from a desktop.
//   slide  A 13.33 x 7.5 in slide less its margins and a title line. Several widths, and for
//          the grids several column counts, because a slide is short and wide and changing
//          the layout is the only way to keep labels legible on one. Nothing below 600px,
//          which stays clear of the stacked phone layout the chart switches to at 540.
export const FORMATS = {
  print: { label: "Print (A4)", box: [6.3, 8.5], widths: [720], cols: false },
  slide: {
    label: "Slide (16:9)", box: [12.3, 5.8],
    widths: [600, 680, 760, 860, 980, 1120, 1280], cols: true,
  },
};

/**
 * Draw a figure laid out for `format` and return the exported copy — legend baked in, plus
 * the title and notes if `extras` carries them — ready to serialize.
 *
 * @param {Function} draw     (host, overrides) => void. Draws the figure into `host` the way
 *                            the page does, with `overrides` spread over its config. Only
 *                            `cols` is ever passed; the width comes from the host.
 * @param {string}   format   a key of FORMATS
 * @param {object}   [extras] { title, notes }, passed through to exportSvg
 * @param {number}   [maxCols] how many panels the figure has, so how many columns are worth
 *                            trying. 1 for a figure that is not a grid.
 * @returns {SVGElement|null}
 */
export function drawForFormat(draw, format, extras = {}, maxCols = 1) {
  const f = FORMATS[format] ?? FORMATS.print;
  const [boxW, boxH] = f.box;
  const colsToTry = f.cols && maxCols > 1
    ? Array.from({ length: Math.min(maxCols, 5) }, (_, i) => i + 1) : [undefined];

  // Off-screen but IN the document. The charts read host.clientWidth and fall back to 660px,
  // silently, when it is zero, which is what a detached host reports. No max-width, because
  // .chart-host caps at 720 and the slide candidates run past it.
  const host = document.createElement("div");
  host.style.cssText = "position:absolute; left:-10000px; top:0; max-width:none;";
  document.body.appendChild(host);

  const tried = [];
  try {
    for (const width of f.widths) {
      host.style.width = `${width}px`;
      for (const cols of colsToTry) {
        draw(host, cols == null ? {} : { cols });
        const svg = host.querySelector("svg.prospect-svg");
        if (!svg) continue;
        // Measured on the EXPORTED copy, legend and any title or notes included, since that
        // is what has to fit — and the legend wraps onto more lines as the width falls.
        const out = exportSvg(svg, extras);
        const w = Number(out.getAttribute("width"));
        const h = Number(out.getAttribute("height"));
        const fit = Math.min(boxW / w, boxH / h);
        tried.push({ out, fit, filled: w * h * fit * fit });
      }
    }
  } finally {
    host.remove();
  }
  if (!tried.length) return null;

  // Largest text wins. But a figure too tall for the box fits its height at every width, so
  // its text comes out the same at all of them, and then the widest is the better figure —
  // it uses the slide instead of leaving its sides empty. "The same" is anything within 3%,
  // a difference in label size nobody could see.
  const best = Math.max(...tried.map((c) => c.fit));
  return tried.filter((c) => c.fit >= best * 0.97)
    .sort((a, b) => b.filled - a.filled)[0].out;
}
