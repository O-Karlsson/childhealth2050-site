// Fetch and cache the site's data files.
//
// locations.json and summary.json load once and together render the whole
// Trajectories page. The series/ files are lazy — nothing fetches them until a
// figure actually plots time. See data-processing/README.md for the contract.

const BASE = new URL("../data/", import.meta.url);
const cache = new Map();

function get(name) {
  if (!cache.has(name)) {
    cache.set(name, fetch(new URL(name, BASE)).then((r) => {
      if (!r.ok) throw new Error(`${name}: HTTP ${r.status}`);
      return r.json();
    }));
  }
  return cache.get(name);
}

export const locations = () => get("locations.json");
export const summary = () => get("summary.json");
export const series = (outcome) => get(`series/${outcome}.json`);
