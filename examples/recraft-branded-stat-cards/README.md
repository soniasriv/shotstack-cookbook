# Recraft brand-consistent stat cards

Turn a spreadsheet of numbers into animated social posts that share one
visual style. The script asks Recraft for a background per row in your brand
colours. It then renders each stat as a short video in 1:1 and 9:16, with a
counting number, a label and an accent bar. You get two MP4 files per row in
`output/`.

The script is resumable. Backgrounds already generated are reused, and
formats already rendered are skipped.

## Requirements

- A [Shotstack account](https://dashboard.shotstack.io/register) and your
  **production** API key
- A [Recraft account](https://www.recraft.ai) and an API key
- Node.js 20 or later

Each row generates two images at Recraft, one per format. Each format is one
Shotstack render.

## Setup

```bash
git clone https://github.com/shotstack/shotstack-cookbook.git
cd shotstack-cookbook/examples/recraft-branded-stat-cards
cp .env.example .env
```

Load the file into your shell. Do this in each new terminal:

```bash
set -a
source .env
set +a
```

Edit `brand.json` with your accent colour and palette. Edit `stats.csv`: one
row per post, with the `stat` number, an optional `suffix`, a `label` and the
image `prompt`. To keep every background in one custom style, create a style
at Recraft and set `RECRAFT_STYLE_ID`.

## Run

```bash
node stat-cards.mjs
```

## What happens

For each row and format the script sends the prompt to Recraft with your
palette as preferred colours. Recraft links are temporary, so the image is
copied to the Shotstack Ingest API and the permanent link is saved in
`output/manifest.json`.

The script then renders `template.json` twice per row. The number counts up
from zero with an HTML5 asset. The label fades in above it. An SVG accent bar
in your brand colour sits between them. The background zooms slowly with a
darken filter so the text stays readable.

To change the look, edit `template.json`. The count-up speed is in the `js`
field of the HTML5 asset.
