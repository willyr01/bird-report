#!/usr/bin/env node
// Builds an HTML report of notable eBird sightings near a fixed home location.
// Usage: EBIRD_KEY=xxx node generate.js [--mock] [--out report.html]

const fs = require("fs");

// ---------------- config ----------------
// Search center comes from the environment so the coordinates are not committed
// to this repo. Set HOME_LAT and HOME_LNG as repository secrets alongside
// EBIRD_KEY. The --mock fallback below is a rough placeholder for rendering only.
const HOME = {
  lat: Number(process.env.HOME_LAT ?? 40.80),
  lng: Number(process.env.HOME_LNG ?? -74.24),
};
const RADIUS_KM = 15;
const DAYS_BACK = 7;
const TZ = "America/New_York";
// ----------------------------------------

const args = process.argv.slice(2);
const MOCK = args.includes("--mock");
const OUT = (() => {
  const i = args.indexOf("--out");
  return i >= 0 ? args[i + 1] : "docs/index.html";
})();

// ---------- geometry ----------
function haversineKm(lat1, lon1, lat2, lon2) {
  const R = 6371, toRad = d => (d * Math.PI) / 180;
  const dLat = toRad(lat2 - lat1), dLon = toRad(lon2 - lon1);
  const a = Math.sin(dLat / 2) ** 2 +
    Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.sin(dLon / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(a));
}

// Local tangent-plane projection: km east / km north of HOME.
function toKmXY(lat, lng) {
  const latRad = (HOME.lat * Math.PI) / 180;
  return {
    x: (lng - HOME.lng) * 111.320 * Math.cos(latRad),
    y: (lat - HOME.lat) * 110.574,
  };
}

// ---------- dates ----------
function parseObsDate(s) {
  if (!s) return null;
  const m = String(s).match(/^(\d{4})-(\d{2})-(\d{2})(?:[ T](\d{2}):(\d{2}))?/);
  if (!m) return null;
  return new Date(+m[1], +m[2] - 1, +m[3], +(m[4] || 0), +(m[5] || 0));
}

function ago(date, now = new Date()) {
  if (!date) return "date unknown";
  const hrs = (now - date) / 36e5;
  if (hrs < 0) return "just now";
  if (hrs < 1) return "under an hour ago";
  if (hrs < 24) return `${Math.round(hrs)}h ago`;
  const d = Math.round(hrs / 24);
  return d === 1 ? "yesterday" : `${d} days ago`;
}

function freshness(date, now = new Date()) {
  if (!date) return "stale";
  const hrs = (now - date) / 36e5;
  if (hrs <= 12) return "today";
  if (hrs <= 48) return "recent";
  return "stale";
}

// ---------- fetch ----------
async function fetchNotable(key) {
  const url = "https://api.ebird.org/v2/data/obs/geo/recent/notable" +
    `?lat=${HOME.lat.toFixed(4)}&lng=${HOME.lng.toFixed(4)}` +
    `&dist=${RADIUS_KM}&back=${DAYS_BACK}&detail=full`;
  const res = await fetch(url, { headers: { "x-ebirdapitoken": key } });
  if (!res.ok) throw new Error(`eBird returned ${res.status} ${res.statusText}`);
  const data = await res.json();
  return Array.isArray(data) ? data : [];
}

// ---------- shape the data ----------
// Group by location. A birder drives to a place, not to a coordinate, so the
// unit of the report is "this hotspot has N notable species right now".
function groupByLocation(obs, now = new Date()) {
  const locs = new Map();
  for (const o of obs) {
    if (typeof o.lat !== "number" || typeof o.lng !== "number") continue;
    const id = o.locId || `${o.lat},${o.lng}`;
    if (!locs.has(id)) {
      locs.set(id, {
        id,
        name: o.locName || "Unnamed location",
        lat: o.lat,
        lng: o.lng,
        km: haversineKm(HOME.lat, HOME.lng, o.lat, o.lng),
        private: o.locationPrivate === true,
        species: new Map(),
      });
    }
    const loc = locs.get(id);
    const key = o.speciesCode || o.comName;
    const when = parseObsDate(o.obsDt);
    const prior = loc.species.get(key);
    const rec = {
      name: o.comName || o.sciName || "Unknown",
      sci: o.sciName || "",
      count: typeof o.howMany === "number" ? o.howMany : null,
      when,
      subId: o.subId || null,
      reviewed: o.obsReviewed === true,
      valid: o.obsValid !== false,
      reports: 1,
    };
    if (!prior) {
      loc.species.set(key, rec);
    } else {
      rec.reports = prior.reports + 1;
      const newer = (when?.getTime() || 0) > (prior.when?.getTime() || 0);
      loc.species.set(key, newer ? rec : { ...prior, reports: rec.reports });
    }
  }

  const out = [...locs.values()].map(l => {
    const species = [...l.species.values()]
      .sort((a, b) => (b.when?.getTime() || 0) - (a.when?.getTime() || 0));
    const latest = species[0]?.when || null;
    return { ...l, species, latest, freshness: freshness(latest, now) };
  });

  // Freshest location first; distance breaks ties.
  out.sort((a, b) =>
    (b.latest?.getTime() || 0) - (a.latest?.getTime() || 0) || a.km - b.km);
  return out;
}

// ---------- SVG map ----------
// No basemap: artifact CSP blocks external tile images. Instead, true-to-scale
// positions with distance rings, which is what "are these near each other"
// actually needs.
function buildMap(locs) {
  const W = 680, H = 560, PAD = 46;
  const maxKm = Math.max(RADIUS_KM, ...locs.map(l => l.km)) * 1.08;
  const R = Math.min(W - PAD * 2, H - PAD * 2) / 2;
  const cx = W / 2, cy = H / 2;
  const s = R / maxKm;

  const pts = locs.map(l => {
    const { x, y } = toKmXY(l.lat, l.lng);
    return { ...l, px: cx + x * s, py: cy - y * s };
  });

  // Rings at sensible intervals.
  const step = maxKm > 30 ? 10 : maxKm > 15 ? 5 : 2;
  const rings = [];
  for (let r = step; r <= maxKm; r += step) rings.push(r);

  let svg = `<svg viewBox="0 0 ${W} ${H}" role="img" aria-label="Map of notable bird sightings, plotted by distance and direction from the search center" class="map">`;

  // rings + labels
  for (const r of rings) {
    const rr = r * s;
    svg += `<circle cx="${cx}" cy="${cy}" r="${rr.toFixed(1)}" class="ring"/>`;
    svg += `<text x="${cx}" y="${(cy - rr - 5).toFixed(1)}" class="ring-label">${r} km</text>`;
  }

  // compass cross
  svg += `<line x1="${cx}" y1="${PAD * 0.5}" x2="${cx}" y2="${H - PAD * 0.5}" class="axis"/>`;
  svg += `<line x1="${PAD * 0.5}" y1="${cy}" x2="${W - PAD * 0.5}" y2="${cy}" class="axis"/>`;
  svg += `<text x="${cx}" y="${PAD * 0.5 - 8}" class="compass">N</text>`;

  // home
  svg += `<circle cx="${cx}" cy="${cy}" r="5" class="home"/>`;
  svg += `<text x="${cx + 10}" y="${cy + 4}" class="home-label">home</text>`;

  // sightings
  pts.forEach((p, i) => {
    const n = p.species.length;
    const r = 7 + Math.min(n - 1, 5) * 2.4;
    svg += `<circle cx="${p.px.toFixed(1)}" cy="${p.py.toFixed(1)}" r="${r.toFixed(1)}" class="pin pin-${p.freshness}"/>`;
    svg += `<text x="${p.px.toFixed(1)}" y="${(p.py + 4).toFixed(1)}" class="pin-num">${i + 1}</text>`;
  });

  svg += `</svg>`;
  return svg;
}

// ---------- HTML ----------
const esc = s => String(s).replace(/[&<>"']/g, c =>
  ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));

function buildHtml(locs, now) {
  const stamp = now.toLocaleString("en-US", {
    timeZone: TZ, weekday: "short", month: "short", day: "numeric",
    hour: "numeric", minute: "2-digit",
  });
  const totalSpecies = new Set(
    locs.flatMap(l => l.species.map(s => s.name))).size;
  const fresh = locs.filter(l => l.freshness === "today").length;

  const cards = locs.map((l, i) => {
    const species = l.species.map(s => {
      const count = s.count ? ` <span class="count">×${s.count}</span>` : "";
      const reports = s.reports > 1
        ? ` <span class="meta">${s.reports} reports</span>` : "";
      const flag = !s.valid
        ? ` <span class="chip chip-warn">needs review</span>` : "";
      const link = s.subId
        ? `<a href="https://ebird.org/checklist/${esc(s.subId)}" target="_blank" rel="noopener">checklist</a>`
        : "";
      return `<li>
        <div class="sp-main"><span class="sp-name">${esc(s.name)}</span>${count}${flag}</div>
        <div class="sp-sub"><em>${esc(s.sci)}</em></div>
        <div class="sp-meta">${esc(ago(s.when, now))}${reports} ${link}</div>
      </li>`;
    }).join("");

    return `<article class="loc">
      <header class="loc-head">
        <span class="pin-badge pin-${l.freshness}">${i + 1}</span>
        <div class="loc-id">
          <h3>${esc(l.name)}</h3>
          <p class="loc-meta"><span class="km">${l.km.toFixed(1)} km</span> · ${l.species.length} notable species · last report ${esc(ago(l.latest, now))}${l.private ? ' · <span class="chip">personal location</span>' : ""}</p>
        </div>
      </header>
      <ul class="sp-list">${species}</ul>
    </article>`;
  }).join("");

  const empty = `<div class="empty">
    <p>No notable sightings reported within ${RADIUS_KM} km in the last ${DAYS_BACK} days.</p>
    <p class="empty-sub">Quiet stretches are normal outside migration. The next run will check again.</p>
  </div>`;

  return `<title>Nearby Notable Birds</title>
<link rel="stylesheet" href="https://fonts.googleapis.com/css2?family=Newsreader:ital,opsz,wght@0,6..72,400;0,6..72,600;1,6..72,400&family=IBM+Plex+Sans:wght@400;500;600&family=IBM+Plex+Mono:wght@400;500&display=swap">
<style>
  /* Layout: a single column — summary, scale map, then one card per hotspot. */
  :root {
    --bg: #f6f6f3;
    --surface: #ffffff;
    --fg: #22251f;
    --fg-dim: #5d6157;
    --fg-faint: #8b8f84;
    --line: #dcdcd4;
    --accent: #9a6b1f;        /* ochre — fresh sightings */
    --accent-soft: #c9a86a;
    --cool: #5c7a86;          /* older sightings */
    --warn: #8a5a2b;
    --display: "Newsreader", Georgia, "Times New Roman", serif;
    --body: "IBM Plex Sans", system-ui, -apple-system, sans-serif;
    --mono: "IBM Plex Mono", ui-monospace, "SF Mono", Menlo, monospace;
  }
  @media (prefers-color-scheme: dark) {
    :root:not([data-theme="light"]) {
      --bg: #161814;
      --surface: #1e211c;
      --fg: #e8e9e2;
      --fg-dim: #a9ad9f;
      --fg-faint: #767a6d;
      --line: #32362d;
      --accent: #d9a94f;
      --accent-soft: #8a7338;
      --cool: #8fb0bd;
      --warn: #d49a5c;
      color-scheme: dark;
    }
  }
  :root[data-theme="dark"] {
    --bg: #161814;
    --surface: #1e211c;
    --fg: #e8e9e2;
    --fg-dim: #a9ad9f;
    --fg-faint: #767a6d;
    --line: #32362d;
    --accent: #d9a94f;
    --accent-soft: #8a7338;
    --cool: #8fb0bd;
    --warn: #d49a5c;
    color-scheme: dark;
  }

  body { background: var(--bg); color: var(--fg); font-family: var(--body); line-height: 1.5; }
  .wrap { max-width: 720px; margin: 0 auto; padding-inline: 18px; padding-block: 28px 56px; display: flex; flex-direction: column; gap: 26px; }

  .masthead { display: flex; flex-direction: column; gap: 6px; border-bottom: 2px solid var(--fg); padding-bottom: 12px; }
  .masthead h1 { font-family: var(--display); font-weight: 600; font-size: clamp(1.7rem, 6vw, 2.3rem); margin: 0; letter-spacing: -0.01em; text-wrap: balance; }
  .stamp { font-family: var(--mono); font-size: 0.74rem; letter-spacing: 0.04em; text-transform: uppercase; color: var(--fg-dim); }

  .summary { display: flex; flex-wrap: wrap; gap: 10px 26px; font-size: 0.92rem; color: var(--fg-dim); }
  .summary b { font-family: var(--mono); font-weight: 500; color: var(--fg); font-variant-numeric: tabular-nums; }

  .map-panel { background: var(--surface); border: 1px solid var(--line); border-radius: 3px; padding: 10px 10px 4px; }
  .map { display: block; width: 100%; height: auto; max-width: 100%; }
  .ring { fill: none; stroke: var(--line); stroke-width: 1; }
  .ring-label { fill: var(--fg-faint); font-family: var(--mono); font-size: 10px; text-anchor: middle; }
  .axis { stroke: var(--line); stroke-width: 1; stroke-dasharray: 2 5; }
  .compass { fill: var(--fg-faint); font-family: var(--mono); font-size: 11px; text-anchor: middle; }
  .home { fill: var(--fg); }
  .home-label { fill: var(--fg-dim); font-family: var(--mono); font-size: 10px; }
  .pin { stroke: var(--surface); stroke-width: 1.5; }
  .pin-today { fill: var(--accent); }
  .pin-recent { fill: var(--accent-soft); }
  .pin-stale { fill: var(--cool); }
  .pin-num { fill: var(--surface); font-family: var(--mono); font-size: 10px; font-weight: 500; text-anchor: middle; }
  .legend { display: flex; flex-wrap: wrap; gap: 6px 16px; font-size: 0.74rem; color: var(--fg-dim); font-family: var(--mono); padding: 8px 2px 6px; }
  .legend span { display: inline-flex; align-items: center; gap: 6px; }
  .dot { width: 9px; height: 9px; border-radius: 50%; display: inline-block; }

  .loc { background: var(--surface); border: 1px solid var(--line); border-radius: 3px; padding: 16px; display: flex; flex-direction: column; gap: 12px; }
  .loc-head { display: flex; gap: 12px; align-items: flex-start; }
  .pin-badge { flex: none; width: 26px; height: 26px; border-radius: 50%; display: grid; place-items: center; font-family: var(--mono); font-size: 0.78rem; color: var(--surface); }
  .pin-badge.pin-today { background: var(--accent); }
  .pin-badge.pin-recent { background: var(--accent-soft); }
  .pin-badge.pin-stale { background: var(--cool); }
  .loc-id { min-width: 0; }
  .loc-id h3 { font-family: var(--display); font-size: 1.12rem; font-weight: 600; margin: 0 0 2px; text-wrap: balance; }
  .loc-meta { margin: 0; font-size: 0.8rem; color: var(--fg-dim); }
  .km { font-family: var(--mono); color: var(--fg); font-variant-numeric: tabular-nums; }

  .sp-list { list-style: none; margin: 0; padding: 0; display: flex; flex-direction: column; gap: 10px; border-top: 1px solid var(--line); padding-top: 12px; }
  .sp-list li { display: flex; flex-direction: column; gap: 1px; min-width: 0; }
  .sp-main { font-size: 0.98rem; font-weight: 500; }
  .sp-sub { font-family: var(--display); font-size: 0.82rem; color: var(--fg-faint); }
  .sp-meta { font-family: var(--mono); font-size: 0.74rem; color: var(--fg-dim); display: flex; flex-wrap: wrap; gap: 8px; }
  .sp-meta a { color: var(--accent); }
  .count { font-family: var(--mono); font-size: 0.82rem; color: var(--fg-dim); }
  .meta { color: var(--fg-faint); }

  .chip { display: inline-block; font-family: var(--mono); font-size: 0.66rem; text-transform: uppercase; letter-spacing: 0.05em; border: 1px solid var(--line); border-radius: 2px; padding: 1px 5px; color: var(--fg-dim); }
  .chip-warn { color: var(--warn); border-color: var(--warn); }

  .empty { background: var(--surface); border: 1px solid var(--line); border-radius: 3px; padding: 26px 18px; text-align: center; }
  .empty p { margin: 0 0 6px; }
  .empty-sub { font-size: 0.86rem; color: var(--fg-dim); }

  .foot { font-size: 0.76rem; color: var(--fg-faint); border-top: 1px solid var(--line); padding-top: 12px; }
  .foot a { color: var(--fg-dim); }
  a { color: var(--accent); }
  a:focus-visible, .sp-meta a:focus-visible { outline: 2px solid var(--accent); outline-offset: 2px; }
</style>

<div class="wrap">
  <header class="masthead">
    <h1>Notable Birds Nearby</h1>
    <p class="stamp">${esc(stamp)} · within ${RADIUS_KM} km of the search center</p>
  </header>

  <div class="summary">
    <span><b>${locs.length}</b> location${locs.length === 1 ? "" : "s"}</span>
    <span><b>${totalSpecies}</b> notable species</span>
    <span><b>${fresh}</b> reported today</span>
    <span>last <b>${DAYS_BACK}</b> days</span>
  </div>

  ${locs.length ? `<div class="map-panel">
    ${buildMap(locs)}
    <div class="legend">
      <span><i class="dot" style="background:var(--accent)"></i>today</span>
      <span><i class="dot" style="background:var(--accent-soft)"></i>1–2 days</span>
      <span><i class="dot" style="background:var(--cool)"></i>older</span>
      <span>larger circle = more species</span>
    </div>
  </div>` : ""}

  ${locs.length ? cards : empty}

  <footer class="foot">
    Data from the <a href="https://ebird.org" target="_blank" rel="noopener">eBird</a> API, Cornell Lab of Ornithology.
    "Notable" is eBird's regional rarity flag, not a personal life-list filter.
    Reports marked <em>needs review</em> have not been confirmed by a regional editor yet.
  </footer>
</div>`;
}

// ---------- mock ----------
function mockData(now) {
  const f = d => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")} ${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}`;
  const h = n => f(new Date(now - n * 36e5));
  return [
    { speciesCode: "conwar", comName: "Connecticut Warbler", sciName: "Oporornis agilis", locId: "L152773", locName: "Garret Mountain Reservation", lat: 40.8865, lng: -74.1890, obsDt: h(3), howMany: 1, subId: "S211", obsValid: true },
    { speciesCode: "conwar", comName: "Connecticut Warbler", sciName: "Oporornis agilis", locId: "L152773", locName: "Garret Mountain Reservation", lat: 40.8865, lng: -74.1890, obsDt: h(26), howMany: 1, subId: "S212", obsValid: true },
    { speciesCode: "yebcha", comName: "Yellow-breasted Chat", sciName: "Icteria virens", locId: "L152773", locName: "Garret Mountain Reservation", lat: 40.8865, lng: -74.1890, obsDt: h(5), howMany: 1, subId: "S213", obsValid: true },
    { speciesCode: "cacgoo1", comName: "Cackling Goose", sciName: "Branta hutchinsii", locId: "L130814", locName: "Branch Brook Park", lat: 40.7700, lng: -74.1800, obsDt: h(9), howMany: 2, subId: "S214", obsValid: true },
    { speciesCode: "eurwig", comName: "Eurasian Wigeon", sciName: "Mareca penelope", locId: "L130814", locName: "Branch Brook Park", lat: 40.7700, lng: -74.1800, obsDt: h(31), howMany: 1, subId: "S215", obsValid: false },
    { speciesCode: "reshaw", comName: "Red-shouldered Hawk", sciName: "Buteo lineatus", locId: "L287014", locName: "South Mountain Reservation", lat: 40.7560, lng: -74.2800, obsDt: h(52), howMany: 1, subId: "S216", obsValid: true },
    { speciesCode: "amebit", comName: "American Bittern", sciName: "Botaurus lentiginosus", locId: "L164432", locName: "Troy Meadows", lat: 40.8450, lng: -74.3650, obsDt: h(96), howMany: 1, subId: "S217", obsValid: true },
    { speciesCode: "nsjaeg", comName: "Nelson's Sparrow", sciName: "Ammospiza nelsoni", locId: "L164432", locName: "Troy Meadows", lat: 40.8450, lng: -74.3650, obsDt: h(99), howMany: 3, subId: "S218", obsValid: true },
    { speciesCode: "sedwre", comName: "Sedge Wren", sciName: "Cistothorus stellaris", locId: "L164432", locName: "Troy Meadows", lat: 40.8450, lng: -74.3650, obsDt: h(101), howMany: 1, subId: "S219", obsValid: false },
    { speciesCode: "lesyel", comName: "Lesser Yellowlegs", sciName: "Tringa flavipes", locId: "L425534", locName: "DeKorte Park", lat: 40.7900, lng: -74.0900, obsDt: h(7), howMany: 4, subId: "S220", obsValid: true, locationPrivate: false },
  ];
}

// ---------- main ----------
(async () => {
  const now = new Date();
  let obs;
  if (MOCK) {
    obs = mockData(now);
  } else {
    const key = process.env.EBIRD_KEY;
    if (!key) { console.error("EBIRD_KEY not set"); process.exit(1); }
    if (!process.env.HOME_LAT || !process.env.HOME_LNG) {
      console.error("HOME_LAT / HOME_LNG not set — refusing to run live against the placeholder center.");
      process.exit(1);
    }
    obs = await fetchNotable(key);
  }
  const locs = groupByLocation(obs, now);
  fs.writeFileSync(OUT, buildHtml(locs, now));
  console.error(`wrote ${OUT}: ${locs.length} locations, ${obs.length} raw observations`);
})();
