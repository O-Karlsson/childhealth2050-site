// Site-wide number formatting.
//
// One rule everywhere unless a figure explicitly states otherwise:
//   >= 10   whole number      (39, 177, 1,284)
//   1 – 10  one decimal       (4.7)
//   < 1     two decimals      (0.54)
//
// Data files store 4 significant figures; this decides what a reader sees.

export function num(v) {
  if (v == null || !Number.isFinite(v)) return "–";
  // Exact zero is a goalpost, not a measurement — "0.00" reads as false precision.
  if (v === 0) return "0";
  const a = Math.abs(v);
  let d = a >= 10 ? 0 : a >= 1 ? 1 : 2;
  // Rounding can push a value up into the next tier (9.96 -> "10.0"), so take the
  // tier of the rounded result, not of the raw input.
  if (d > 0 && Math.abs(Number(v.toFixed(d))) >= 10) d = 0;
  else if (d > 1 && Math.abs(Number(v.toFixed(d))) >= 1) d = 1;
  return v.toLocaleString(undefined, { minimumFractionDigits: d, maximumFractionDigits: d });
}

export const pct = (v) =>
  v == null || !Number.isFinite(v) ? "–" : `${Math.round(v * 100)}%`;

// "Neonatal mortality, per 1,000 live births" — the full name a reader needs,
// including the scale, rather than an abbreviation.
export const fullName = (meta) => `${meta.label}, ${meta.unit}`;
