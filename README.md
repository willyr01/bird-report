# Nearby bird report

Twice-daily report of notable (regionally rare) eBird sightings within 15 km of
West Orange, NJ, grouped by hotspot and plotted to scale with distance rings.

Live page: `https://<your-username>.github.io/bird-report/`

## How it works

`generate.js` queries the eBird API 2.0 endpoint
`/data/obs/geo/recent/notable`, groups the observations by location, and writes
a self-contained HTML page to `docs/index.html`. A GitHub Actions workflow runs
it on a schedule and commits the result; GitHub Pages serves `docs/`.

No dependencies — plain Node 20 with built-in `fetch`.

## Setup

1. **Repo secret.** Settings → Secrets and variables → Actions → New repository
   secret. Name it `EBIRD_KEY`, paste a key from
   <https://ebird.org/api/keygen>.
2. **Pages.** Settings → Pages → Source: *Deploy from a branch*, branch `main`,
   folder `/docs`.
3. **First run.** Actions → *Build bird report* → Run workflow. Give Pages a
   minute, then open the URL above.

## Settings

Top of `generate.js`:

| Constant | Default | Notes |
| --- | --- | --- |
| `HOME` | Roosevelt Middle School, West Orange | Center of the search |
| `RADIUS_KM` | 15 | eBird caps this at 50. Straight-line, not drive time: roughly 10 km ≈ 15 min, 15 km ≈ 20 min, 20 km ≈ 25–30 min in North Jersey |
| `DAYS_BACK` | 7 | eBird caps this at 30 |

Schedule is in `.github/workflows/report.yml`. Cron is UTC, so the local run
time shifts by an hour between EDT and EST.

## Local testing

```sh
node generate.js --mock --out docs/index.html   # sample data, no key needed
EBIRD_KEY=xxxx node generate.js                 # live
```

## Known limits

- **"Notable" is eBird's regional rarity flag, not a personal life-list
  filter.** There is no public API endpoint for a life list, so the report
  cannot tell you which of these are new *for you*.
- **Distance is straight-line.** A sighting 15 km east toward Newark at rush
  hour is a much longer trip than 15 km west on I-280.
- **GitHub disables scheduled workflows in repos with no activity for 60 days.**
  The bot's own commits may not reset that timer. If reports stop appearing,
  push any commit and re-enable the workflow in the Actions tab.
- **Scheduled Actions runs are queued, not precise.** Expect the job to start
  anywhere from on time to roughly 15 minutes late.

## Data

Observations come from [eBird](https://ebird.org), Cornell Lab of Ornithology.
Use is subject to the [eBird API terms of
use](https://ebird.org/api/keygen) — personal, non-commercial, not for bulk
redistribution.
