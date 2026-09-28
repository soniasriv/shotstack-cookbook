# D-ID explainer video with a presenter in the corner

Turn a slide deck and a script into a narrated explainer. The script reads
`slides.csv` and asks D-ID to make a talking-head clip for each row from one
photo. It then renders the slides in sequence with the presenter in the
bottom-right corner. Captions come from the presenter's speech. You get one 1080p MP4 in
`output/`.

The script is resumable. Talks that D-ID has already made are reused, so a
second run only renders.

## Requirements

- A [Shotstack account](https://dashboard.shotstack.io/register) and your
  **production** API key
- A [D-ID account](https://studio.d-id.com) and an API key
- A public link to a front-facing photo of the presenter
- Node.js 20 or later

Each row makes one D-ID talk. The render transcribes each talk for captions,
which consumes generation credits. Remove the first track in `template.json`
to render without captions.

## Setup

```bash
git clone https://github.com/shotstack/shotstack-cookbook.git
cd shotstack-cookbook/examples/d-id-explainer-video
cp .env.example .env
```

Load the file into your shell. Do this in each new terminal:

```bash
set -a
source .env
set +a
```

Set `PRESENTER_IMAGE` to the photo. Edit `slides.csv`: one row per slide, with
a public `image_url` and the `script` the presenter says over it.

## Run

```bash
node explainer-video.mjs
```

## What happens

For each row the script sends the photo and the text to D-ID and waits for the
clip. D-ID links expire, so each clip is copied to the Shotstack Ingest API and
the permanent link is kept in `output/manifest.json`.

The script then builds one edit from `template.json`. Each slide starts when
the talk before it ends, and each slide stays on screen for exactly as long as
its talk. The presenter clip sits in the corner at 28% size. Captions are read
from each talk. A title card opens the video and an end card closes it.

To change the look, edit `template.json`: the first slide is the pattern the
script copies for every row.
