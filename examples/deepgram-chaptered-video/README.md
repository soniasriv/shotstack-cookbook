# Deepgram chaptered video with word-timed captions

Turn a recorded talk into a video with chapter markers and captions. The script
sends the recording to Deepgram once and builds captions from the word
timings. Each topic Deepgram found becomes a chapter card. Then it renders.
You get one 1080p MP4 and the caption file in `output/`.

The script is resumable. The transcript is kept, so a second run only renders.

## Requirements

- A [Shotstack account](https://dashboard.shotstack.io/register) and your
  **production** API key
- A [Deepgram account](https://console.deepgram.com) and an API key
- A public link to a recording with English speech
- Node.js 20 or later

One run makes one Deepgram request and one Shotstack render. Captions come
from the caption file, not from a second transcription, so the render uses no
generation credits. Deepgram topic detection works for English only.

## Setup

```bash
git clone https://github.com/shotstack/shotstack-cookbook.git
cd shotstack-cookbook/examples/deepgram-chaptered-video
cp .env.example .env
```

Load the file into your shell. Do this in each new terminal:

```bash
set -a
source .env
set +a
```

Set `SOURCE_VIDEO` to the recording.

## Run

```bash
node chaptered-video.mjs
```

## What happens

The script asks Deepgram for the transcript with word timings, paragraphs and
topics. It groups the words into short cues and writes `output/captions.srt`,
then uploads the file to the Shotstack Ingest API. Each topic segment becomes a
chapter card that slides in at the segment's first word and stays for four
seconds. Chapters closer than eight seconds apart are merged.

The edit in `template.json` has three tracks: captions, chapter cards and the
video. The script copies the chapter card once per chapter. To change the look
of the captions or the cards, edit `template.json`. Set `CUE_WORDS` to change
how many words each caption shows.
