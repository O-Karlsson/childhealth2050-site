// Turn a chart's live SVG into a file someone can use somewhere else.
//
// A chart on this site is real SVG DOM, so it looks like `outerHTML` should be
// enough. It is not, and the failure is silent: almost all paint comes from
// site.css, and the SVG initial values are hostile to what is left behind.
//
//   stroke        initial `none`      -> every track line, axis rule and tick VANISHES
//   fill-opacity  initial `1`         -> status bands paint at full saturation
//                                        and bury the plot
//   font          initial ~16px serif -> every label overflows its gutter, because
//                                        prospect-chart.js does no text measurement:
//                                        every gutter is a hard-coded constant
//
// So the styles have to be read back and written onto the elements. Doing it
// through getComputedStyle also fixes a second problem for free: the arrow fills
// ARE set as attributes, but as the literal string `var(--chart-mark)`, which is
// undefined outside this page and ignored by every standalone renderer.

const PAINT = [
  "fill", "fill-opacity", "fill-rule",
  "stroke", "stroke-width", "stroke-opacity",
  "stroke-linecap", "stroke-linejoin", "stroke-dasharray",
  "paint-order", "opacity",
];

const TEXT = [
  "font-family", "font-size", "font-weight", "font-style",
  "font-variant-numeric", "letter-spacing",
  "text-anchor", "dominant-baseline",
];

// `text-transform` is deliberately NOT in that list, and adding it does not work. SVG has
// no text-transform presentation attribute, so the attribute is inert in the file: the
// panel headings read HIGH UNDER-20 MORTALITY on screen and download as "High under-20
// mortality". Writing it as `style=` works in Chrome and is ignored by librsvg and most
// SVG-to-PDF paths, so the only form that survives everywhere is to transform the text
// itself. See applyTextTransform below.

// Lengths a standalone renderer is happier receiving unitless: browsers report
// these as e.g. "2px", and SVG 1.1 renderers such as librsvg want "2".
const STRIP_PX = new Set(["stroke-width", "font-size", "letter-spacing"]);

// The font family needs no handling here. `.figure-export-light` in site.css sets the
// export copy in Arial, so the computed value inlined below is already a font every
// renderer has. (It used to be `system-ui`, resolved to the exporting machine's own font:
// Segoe UI from Windows, SF Pro from a Mac. See ADR-041.)

// Write the computed value of every paint and text property onto each element as
// a presentation attribute. A flat list applied to everything, deliberately: SVG
// ignores attributes that do not apply to an element, so this cannot miss a case,
// where a per-element-type table goes stale the first time the chart gains a mark.
function inlineComputedStyles(svg) {
  for (const el of [svg, ...svg.querySelectorAll("*")]) {
    const computed = getComputedStyle(el);

    for (const prop of [...PAINT, ...TEXT]) {
      let value = computed.getPropertyValue(prop).trim();
      if (!value || value === "normal" || value === "auto") continue;

      if (STRIP_PX.has(prop)) value = value.replace(/px$/, "");

      el.setAttribute(prop, value);
    }
  }
}

// Bake a computed text-transform into the characters, because the property cannot travel
// with the file. Only the element's OWN text nodes are rewritten, so a <text> holding
// <tspan> children keeps its structure and each tspan is reached on its own pass.
function applyTextTransform(svg) {
  for (const el of svg.querySelectorAll("text, tspan")) {
    const t = getComputedStyle(el).textTransform;
    if (t !== "uppercase" && t !== "lowercase" && t !== "capitalize") continue;
    for (const node of el.childNodes) {
      if (node.nodeType !== Node.TEXT_NODE) continue;
      node.nodeValue = t === "uppercase" ? node.nodeValue.toUpperCase()
        : t === "lowercase" ? node.nodeValue.toLowerCase()
          : node.nodeValue.replace(/\p{L}+/gu, (w) => w[0].toUpperCase() + w.slice(1));
    }
  }
}

// `paint-order: stroke` is how the value labels get their halo: the stroke is painted
// first, in the page ground, and the text on top of it. Chrome and librsvg honour it;
// PowerPoint and Word do not, and paint the stroke OVER the fill — so every haloed number
// arrived in a slide as a white blob, and one sitting on white ground vanished outright,
// which took the latest values and the on-track counts with it. Splitting each such element
// in two says the same thing in a form every renderer draws alike: a stroke-only copy
// underneath, and the original with its stroke taken off. Descendants are reset too,
// because inlining has already written fill and stroke onto every <tspan>.
function flattenPaintOrder(svg) {
  for (const el of svg.querySelectorAll("[paint-order]")) {
    const strokeFirst = el.getAttribute("paint-order").startsWith("stroke");
    const stroke = el.getAttribute("stroke");
    for (const n of [el, ...el.querySelectorAll("*")]) n.removeAttribute("paint-order");
    if (!strokeFirst || !stroke || stroke === "none"
      || Number(el.getAttribute("stroke-width") ?? 1) === 0) continue;

    const under = el.cloneNode(true);
    for (const n of [under, ...under.querySelectorAll("*")]) n.setAttribute("fill", "none");
    el.parentNode.insertBefore(under, el);
    for (const n of [el, ...el.querySelectorAll("*")]) n.setAttribute("stroke", "none");
  }
}

/**
 * Serialize a chart's SVG to a standalone document string, without touching the
 * original. Always renders light, whatever the reader's theme.
 *
 * The clone is parked in the document before its styles are read. getComputedStyle
 * on a detached node returns nothing, and returns it silently — you get a
 * well-formed SVG with every paint attribute missing, which looks exactly like
 * inlining that ran and found nothing to do.
 *
 * The parking container carries `.figure-export-light`, which re-declares the
 * light tokens. Without it a reader in dark mode downloads a dark figure, and
 * discovers that only once it is in their report.
 */
export function serializeStandaloneSvg(svg) {
  const clone = svg.cloneNode(true);

  const parking = document.createElement("div");
  parking.className = "figure-export-light";
  parking.style.cssText = "position:absolute; left:-10000px; top:0;";
  parking.appendChild(clone);
  document.body.appendChild(parking);

  try {
    // Both need the clone parked: getComputedStyle on a detached node returns nothing,
    // and returns it silently.
    applyTextTransform(clone);
    inlineComputedStyles(clone);
  } finally {
    parking.remove();
  }

  // After inlining, which is what turns the stylesheet's paint-order into an attribute.
  flattenPaintOrder(clone);

  clone.setAttribute("xmlns", "http://www.w3.org/2000/svg");

  // A white ground behind the marks. The chart draws none, because the page
  // supplies it; a file with a transparent background looks broken the moment it
  // lands on a coloured slide.
  const bg = document.createElementNS("http://www.w3.org/2000/svg", "rect");
  bg.setAttribute("x", "0");
  bg.setAttribute("y", "0");
  bg.setAttribute("width", "100%");
  bg.setAttribute("height", "100%");
  bg.setAttribute("fill", "#ffffff");
  clone.insertBefore(bg, clone.firstChild);

  // Hover text on the dot and each arrow. Useful on screen; stray tooltips in a
  // figure viewer.
  for (const title of clone.querySelectorAll("title")) title.remove();

  return `<?xml version="1.0" encoding="UTF-8"?>\n${new XMLSerializer().serializeToString(clone)}\n`;
}

/**
 * Rasterize the same SVG to a PNG blob at `scale` times its on-screen size.
 *
 * Goes through an <img>, which is what makes the browser's own font rendering
 * apply — the reason the SVG must be standalone first, since an <img> gets no
 * stylesheet.
 */
export async function svgToPngBlob(svg, scale = 4) {
  const url = URL.createObjectURL(
    new Blob([serializeStandaloneSvg(svg)], { type: "image/svg+xml" }),
  );

  try {
    const img = new Image();
    await new Promise((resolve, reject) => {
      img.onload = resolve;
      img.onerror = () => reject(new Error("The figure could not be rasterized."));
      img.src = url;
    });

    // From the attributes, not from `svg.width.baseVal`: the figure handed in here is a
    // DETACHED copy carrying its legend, and a detached node has no resolved geometry.
    const canvas = document.createElement("canvas");
    canvas.width = Math.round(Number(svg.getAttribute("width")) * scale);
    canvas.height = Math.round(Number(svg.getAttribute("height")) * scale);

    const ctx = canvas.getContext("2d");
    ctx.fillStyle = "#ffffff";
    ctx.fillRect(0, 0, canvas.width, canvas.height);
    ctx.drawImage(img, 0, 0, canvas.width, canvas.height);

    return await new Promise((resolve) => canvas.toBlob(resolve, "image/png"));
  } finally {
    URL.revokeObjectURL(url);
  }
}

/** Save a blob under `filename`. */
export function saveBlob(blob, filename) {
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  // Revoking immediately cancels the download in Safari.
  setTimeout(() => URL.revokeObjectURL(url), 10_000);
}
