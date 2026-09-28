# Camb.ai localised videos with translated captions

Turn one video into a version for each language. The script asks Camb.ai to
dub the video into every language in `languages.csv`. It then renders each
one with the original voice muted and the dubbed voice in its place. Captions
come from Camb.ai's translated dialogue, and a badge names the language. You get one 1080p
MP4 and one caption file per language in `output/`.

The script is resumable. Dubs already made are reused, and languages already
rendered are skipped.

## Requirements

- A [Shotstack account](https://dashboard.shotstack.io/register) and your
  **production** API key
- A [Camb.ai account](https://studio.camb.ai) and an API key
- A public link to a video with speech
- Node.js 20 or later

Each language is one Camb.ai dubbing task and one Shotstack render. Captions
come from the caption file, so the render uses no generation credits. A
dubbing task can take several minutes; the script waits.

## Setup

```bash
git clone https://github.com/shotstack/shotstack-cookbook.git
cd shotstack-cookbook/examples/camb-localised-videos
cp .env.example .env
```

Load the file into your shell. Do this in each new terminal:

```bash
set -a
source .env
set +a
```

Set `SOURCE_VIDEO` to your video and `SOURCE_LANGUAGE` to its language. Edit
`languages.csv`: one row per target language, with the Camb.ai language tag and
the `label` for the badge. The tags are listed in the
[Camb.ai documentation](https://docs.camb.ai/api-reference/endpoint/get-target-languages).

## Run

```bash
node localised-videos.mjs
```

## What happens

For each language the script starts a Camb.ai dubbing task and polls it every
30 seconds until it succeeds. The result has the dubbed audio and the
translated dialogue with timings. The audio is copied to the Shotstack Ingest
API, and the dialogue is written to `output/<language>.srt` and uploaded too.

The script then renders `template.json`. The source video plays with its own
audio silenced and the dubbed audio on top. Captions come from the caption
file, and the badge shows the language. The dubbed audio is capped to the length of the source video.

To change the look, edit `template.json`. Delete a language from
`manifest.json` to render it again.
