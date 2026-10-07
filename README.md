# Nearby bird report

Twice-daily report of notable (regionally rare) eBird sightings within 15 km of
a configured search center, grouped by hotspot and plotted to scale with
distance rings.

## How it works

`generate.js` queries the eBird API 2.0 endpoint
`/data/obs/geo/recent/notable`, groups the observations by location, and writes
a self-contained HTML page to `docs/index.html`. A GitHub Actions workflow runs
it on a schedule and commits the result; GitHub Pages serves `docs/`.

No dependencies — plain Node 20 with built-in `fetch`.

## Setup

1. **Repo secrets.** Settings → Secrets and variables → Actions. Add three:
   - `EBIRD_KEY` — a key from <https://ebird.org/api/keygen>
   - `HOME_LAT` — search center latitude, e.g. `40.7713`
   - `HOME_LNG` — search center longitude, e.g. `-74.2569`

   The coordinates live in secrets rather than in the source so this repo can be
   public without publishing them.
2. **Pages.** Settings → Pages → Source: *Deploy from a branch*, branch `main`,
   folder `/docs`.
3. **First run.** Actions → *Build bird report* → Run workflow.

## Settings

Top of `generate.js`:

| Constant | Default | Notes |
| --- | --- | --- |
| `RADIUS_KM` | 15 | eBird caps this at 50. Straight-line, not drive time: roughly 10 km ≈ 15 min, 15 km ≈ 20 min, 20 km ≈ 25–30 min in North Jersey |
| `DAYS_BACK` | 7 | eBird caps this at 30 |
| `TZ` | `America/New_York` | Used for the timestamp in the report header |

Schedule is in `.github/workflows/report.yml`. Cron is UTC, so the local run
time shifts by an hour between EDT and EST.

## Local testing

```sh
node generate.js --mock --out docs/index.html        # sample data, no key needed
EBIRD_KEY=xxx HOME_LAT=40.77 HOME_LNG=-74.26 node generate.js
```

Live runs refuse to start without `HOME_LAT` and `HOME_LNG`, so a misconfigured
run fails loudly instead of silently reporting on the placeholder center.

## Known limits

- **"Notable" is eBird's regional rarity flag, not a personal life-list
  filter.** There is no public API endpoint for a life list, so the report
  cannot tell you which of these are new *for you*.
- **Distance is straight-line.** A sighting 15 km east through city traffic is a
  much longer trip than 15 km west on a highway.
- **The rendered page still implies the search center.** Hotspot names and their
  distances are enough to triangulate it to within a few hundred meters. Keeping
  the coordinates out of the source stops them being read directly; it does not
  make the center unknowable from the published report.
- **GitHub disables scheduled workflows in repos with no activity for 60 days.**
  The bot's own commits may not reset that timer. If reports stop appearing,
  push any commit and re-enable the workflow in the Actions tab.
- **Scheduled Actions runs are queued, not precise.** Expect the job to start
  anywhere from on time to roughly 15 minutes late.

## Data

Observations come from [eBird](https://ebird.org), Cornell Lab of Ornithology.
Use is subject to the [eBird API terms of use](https://www.birds.cornell.edu/home/ebird-api-terms-of-use/)
— personal, non-commercial, with attribution.
