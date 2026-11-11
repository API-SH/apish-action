# api.sh data snapshot

A GitHub Action that saves public web data to a file in your repository on a schedule, and commits it when it
changes. [API.SH](https://api.sh/?utm_source=github&utm_medium=readme) turns public web pages from around 1,000
websites into clean JSON: search engines, social media, e-commerce, real estate, jobs, travel, news and sports
(Google, Amazon, TikTok, Zillow, LinkedIn and more). One step calls any endpoint and writes the response as JSON,
CSV or NDJSON. The git history becomes your dataset.

```yaml
- uses: API-SH/apish-action@v1
  with:
    api-key: ${{ secrets.APISH_API_KEY }}
    route: /tiktok/v1/profile
    params: "username: nasa"
    path: data/nasa.json
    commit: true
```

## Setup

1. Create an API key at [app.api.sh/keys](https://app.api.sh/keys?utm_source=github&utm_medium=readme). Every
   account gets free monthly credits, and failed calls are free.
2. In your repository, open **Settings > Secrets and variables > Actions > New repository secret**. Name it
   `APISH_API_KEY` and paste the key.
3. Add a workflow from the examples below. With `commit: true`, give the job `permissions: contents: write`.

Keep the key in a secret. Never write it into the workflow file: anyone who can read the repository could use
your credits. The action masks the key in logs. Workflows started from forks do not receive your secrets.

## Examples

### Daily TikTok profile snapshot

Follower and like counts once a day, committed only when they change.

```yaml
name: TikTok snapshot
on:
  schedule:
    - cron: "0 6 * * *"     # 06:00 UTC every day
  workflow_dispatch:

permissions:
  contents: write

jobs:
  snapshot:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - uses: API-SH/apish-action@v1
        with:
          api-key: ${{ secrets.APISH_API_KEY }}
          route: /tiktok/v1/profile
          params: |
            username: nasa
          path: data/tiktok/nasa.json
          commit: true
          commit-message: "TikTok: update @nasa"
```

### Weekly Zillow listings for a ZIP code, as CSV

Every Monday, the homes for sale in 78704 (Austin, TX) as a spreadsheet-ready CSV.

```yaml
name: Zillow listings
on:
  schedule:
    - cron: "0 7 * * 1"     # Mondays 07:00 UTC
  workflow_dispatch:

permissions:
  contents: write

jobs:
  listings:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - uses: API-SH/apish-action@v1
        with:
          api-key: ${{ secrets.APISH_API_KEY }}
          route: /zillow/v1/search
          params: |
            location: "78704"
            status: for_sale
          output: csv
          path: listings/78704.csv
          commit: true
```

Each row is one listing (price, beds, baths, area, address, URL and more). The CSV holds the response's main
list; pick another with `records`.

### Hourly Google rank check

Where does a domain rank for a keyword? Save the top results every hour and fail the run (which emails you) if
the domain drops out of the top 10.

```yaml
name: Rank check
on:
  schedule:
    - cron: "15 * * * *"    # every hour at :15
  workflow_dispatch:

permissions:
  contents: write

jobs:
  rank:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - id: serp
        uses: API-SH/apish-action@v1
        with:
          api-key: ${{ secrets.APISH_API_KEY }}
          route: /google/v1/search
          params: |
            q: running shoes
            country: us
          fields: results.position,results.domain,results.url,results.title
          path: rank/running-shoes.json
          commit: true
      - name: Check the position of nike.com
        run: |
          pos=$(jq '[.results[] | select(.domain | endswith("nike.com"))][0].position // empty' rank/running-shoes.json)
          echo "nike.com position: ${pos:-not in the results}"
          echo "position=${pos}" >> "$GITHUB_OUTPUT"
          if [ -z "$pos" ] || [ "$pos" -gt 10 ]; then echo "::error::nike.com is not in the top 10"; exit 1; fi
```

## Inputs

| Input | Default | Description |
| --- | --- | --- |
| `api-key` | (required) | Your api.sh key. Use a secret: `${{ secrets.APISH_API_KEY }}` |
| `route` | (required) | The endpoint route, e.g. `/tiktok/v1/profile`. Routes and parameters: [api.sh/docs](https://api.sh/docs?utm_source=github&utm_medium=readme) |
| `params` | | The endpoint's parameters as YAML or JSON, e.g. `username: nasa`. Lists become comma-separated |
| `output` | `json` | `json`, `csv` or `ndjson` |
| `path` | `data/<platform>-<endpoint>.<output>` | The file to write, relative to the workspace |
| `raw` | `false` | Include the bulky raw source blocks |
| `fields` | | Only these fields, e.g. `results.title,results.url` |
| `records` | | With `csv`/`ndjson`: which list becomes the rows (`.` for the whole object as one row) |
| `fresh` | `false` | Skip the 24-hour cache and fetch live |
| `strip-meta` | `true` | Leave call metadata (`fetched_at`, `cached`, `credits_used`, `request_id`, `success`) out of JSON files, so the file only changes when the data does |
| `commit` | `false` | Commit and push the file when it changed |
| `commit-message` | `Update {path} from api.sh {route}` | Commit message; `{path}` and `{route}` are replaced |
| `author-name` | `github-actions[bot]` | Commit author name |
| `author-email` | `41898282+github-actions[bot]@users.noreply.github.com` | Commit author email |

## Outputs

| Output | Description |
| --- | --- |
| `path` | The file written |
| `changed` | `true` when the content changed or the file is new |
| `committed` | `true` when a commit was pushed |
| `credits` | Credits the call used |
| `credits-remaining` | Credits left on the account, when reported |
| `request-id` | The call's request id. The same response can be fetched again for free for 30 days |

Use `changed` to run later steps only on new data:

```yaml
      - if: steps.serp.outputs.changed == 'true'
        run: echo "The results changed"
```

## Errors

The step fails with the API's message, the HTTP status and the request id. A bad key (401) or too few credits
(402) fails at once. When the source site does not answer (502/503/504), the call is retried twice with backoff;
failed calls are never charged. Check [status.api.sh](https://status.api.sh) for ongoing incidents.

## Development

```sh
npm install
npm test          # unit tests, a git commit/push test and a run of the bundled dist/index.js
npm run build     # bundles src/ into dist/ (commit dist/ with your change)
```

Run `npm test` and `npm run build` before a pull request; `dist/` must match `src/`.

## License

MIT
