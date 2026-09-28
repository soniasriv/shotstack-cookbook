# HeyGen catalog videos with one avatar intro

Make a vertical video for every product in a spreadsheet, each opened by the
same HeyGen avatar. The script asks HeyGen for the intro once and copies it to
Shotstack. It then renders one 9:16 video per row of `products.csv`. Each has
the avatar intro, three product photos with motion, the name, the price and a
call to action. Music runs under everything and ducks while the avatar speaks.

The script is resumable. The intro is made once and reused, and products
already rendered are skipped.

## Requirements

- A [Shotstack account](https://dashboard.shotstack.io/register) and your
  **production** API key
- A [HeyGen account](https://app.heygen.com) with an API key, an avatar ID
  and a voice ID
- Node.js 20 or later

One run makes one HeyGen video and one Shotstack render per product. The
captions over the intro are transcribed from the avatar's speech, which
consumes generation credits. Remove the first track in `template.json` to
render without captions.

## Setup

```bash
git clone https://github.com/shotstack/shotstack-cookbook.git
cd shotstack-cookbook/examples/heygen-catalog-videos
cp .env.example .env
```

Load the file into your shell. Do this in each new terminal:

```bash
set -a
source .env
set +a
```

Edit `intro.txt` with what the avatar says. Edit `products.csv`: one row per
product, with up to three public image links, a `price`, a `cta` and an
`accent` colour.

## Run

```bash
node catalog-videos.mjs
```

## What happens

The script sends `intro.txt` to HeyGen with your avatar and voice at 1080 by
1920 and waits for the video. HeyGen links expire after seven days, so the clip
is copied to the Shotstack Ingest API and the permanent link is saved in
`output/manifest.json`.

For each product the script fills the merge fields in `template.json` and
renders. The photo montage starts when the intro ends. The name slides in over
the first photo, then the price, then the call to action. The music track
starts quiet under the avatar and rises for the montage.

To change the look, edit `template.json`. Delete a row from `manifest.json` to
render that product again.
