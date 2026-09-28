import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { setTimeout as delay } from 'node:timers/promises';
import { createHash } from 'node:crypto';

// The production environment. For free watermarked test renders, set
// SHOTSTACK_ENV=stage in .env and use your sandbox API key.
const STAGE = process.env.SHOTSTACK_ENV === 'stage' ? 'stage' : 'v1';
const EDIT_URL = `https://api.shotstack.io/edit/${STAGE}`;
const INGEST_URL = `https://api.shotstack.io/ingest/${STAGE}`;
const POLL_INTERVAL_MS = 5_000;
const MAX_WAIT_MS = 15 * 60 * 1_000;

function requireEnv(name, hint) {
  const value = process.env[name];

  if (!value) {
    console.error(`Set the ${name} environment variable first. ${hint}`);
    process.exit(1);
  }

  return value;
}

async function request(url, options, service) {
  let response;

  try {
    response = await fetch(url, {
      signal: AbortSignal.timeout(120_000),
      ...options
    });
  } catch (error) {
    throw new Error(
      `Could not reach the ${service} API. ` +
        'Check your network connection and try again.',
      { cause: error }
    );
  }

  if (!response.ok) {
    const detail = (await response.text()).slice(0, 300);
    throw new Error(`${service} returned ${response.status}: ${detail}`);
  }

  return response;
}

// A small CSV reader. It accepts quoted fields and commas inside quotes.
function parseCsv(text) {
  const rows = [];
  let row = [];
  let field = '';
  let quoted = false;

  for (let i = 0; i < text.length; i += 1) {
    const char = text[i];

    if (quoted) {
      if (char === '"' && text[i + 1] === '"') {
        field += '"';
        i += 1;
      } else if (char === '"') {
        quoted = false;
      } else {
        field += char;
      }
    } else if (char === '"') {
      quoted = true;
    } else if (char === ',') {
      row.push(field.trim());
      field = '';
    } else if (char === '\n' || char === '\r') {
      if (field !== '' || row.length > 0) {
        row.push(field.trim());
        rows.push(row);
        row = [];
        field = '';
      }
    } else {
      field += char;
    }
  }

  if (field !== '' || row.length > 0) {
    row.push(field.trim());
    rows.push(row);
  }

  const header = rows.shift();

  if (!header) {
    throw new Error('The input file is empty.');
  }

  return rows.map(cells =>
    Object.fromEntries(header.map((name, i) => [name, cells[i] ?? '']))
  );
}

function fingerprint(value) {
  return createHash('sha1')
    .update(JSON.stringify(value))
    .digest('hex')
    .slice(0, 12);
}

// The manifest makes the script resumable. Work already done is skipped, and
// media already generated is reused, so a second run costs nothing.
async function readManifest(path) {
  try {
    return JSON.parse(await readFile(path, 'utf8'));
  } catch {
    return { jobs: {}, cache: {} };
  }
}

async function writeManifest(path, manifest) {
  await writeFile(path, `${JSON.stringify(manifest, null, 2)}\n`);
}

async function uploadToShotstack(key, body, contentType, label) {
  const signed = await request(
    `${INGEST_URL}/upload`,
    { method: 'POST', headers: { 'x-api-key': key } },
    'Shotstack Ingest'
  );
  const { data } = await signed.json();
  await request(
    data.attributes.url,
    { method: 'PUT', headers: { 'Content-Type': contentType }, body },
    'Shotstack Ingest'
  );
  const started = Date.now();

  while (Date.now() - started < MAX_WAIT_MS) {
    const poll = await request(
      `${INGEST_URL}/sources/${data.id}`,
      { headers: { 'x-api-key': key } },
      'Shotstack Ingest'
    );
    const source = (await poll.json()).data.attributes;

    if (source.status === 'ready') {
      return source.source;
    }

    if (source.status === 'failed') {
      throw new Error(`Shotstack could not read the ${label}.`);
    }

    await delay(POLL_INTERVAL_MS);
  }

  throw new Error(`Shotstack did not finish reading the ${label} in time.`);
}

async function renderEdit(key, edit, label) {
  const submitted = await request(
    `${EDIT_URL}/render`,
    {
      method: 'POST',
      headers: { 'x-api-key': key, 'Content-Type': 'application/json' },
      body: JSON.stringify(edit)
    },
    'Shotstack'
  );
  const renderId = (await submitted.json()).response.id;
  const started = Date.now();

  while (Date.now() - started < MAX_WAIT_MS) {
    await delay(POLL_INTERVAL_MS);
    const poll = await request(
      `${EDIT_URL}/render/${renderId}`,
      { headers: { 'x-api-key': key } },
      'Shotstack'
    );
    const status = (await poll.json()).response;

    if (status.status === 'done') {
      return status.url;
    }

    if (status.status === 'failed') {
      throw new Error(
        `The ${label} render failed: ${status.error ?? 'no reason given'}`
      );
    }
  }

  throw new Error(`The ${label} render did not finish in time.`);
}

async function download(url, path) {
  const response = await request(url, {}, 'Shotstack CDN');
  await writeFile(path, Buffer.from(await response.arrayBuffer()));
}

function mergeFields(values) {
  return Object.entries(values).map(([find, replace]) => ({
    find,
    replace: String(replace)
  }));
}

const DEEPGRAM_URL = 'https://api.deepgram.com/v1/listen';
const MODEL = process.env.DEEPGRAM_MODEL || 'nova-3';
const CUE_WORDS = Number(process.env.CUE_WORDS || 6);
const CHAPTER_SECONDS = 4;

const shotstackKey = requireEnv(
  'SHOTSTACK_API_KEY',
  'Get it from https://dashboard.shotstack.io.'
);
const deepgramKey = requireEnv(
  'DEEPGRAM_API_KEY',
  'Get it from https://console.deepgram.com.'
);
const sourceVideo = requireEnv(
  'SOURCE_VIDEO',
  'A public https link to the talk or lecture recording.'
);

async function transcribe() {
  const params = new URLSearchParams({
    model: MODEL,
    smart_format: 'true',
    paragraphs: 'true',
    topics: 'true'
  });
  const response = await request(
    `${DEEPGRAM_URL}?${params}`,
    {
      method: 'POST',
      headers: {
        Authorization: `Token ${deepgramKey}`,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({ url: sourceVideo })
    },
    'Deepgram'
  );
  const body = await response.json();
  const alternative = body.results?.channels?.[0]?.alternatives?.[0];

  if (!alternative || !alternative.words?.length) {
    throw new Error('Deepgram returned no speech for that recording.');
  }

  return {
    words: alternative.words,
    paragraphs: alternative.paragraphs?.paragraphs ?? [],
    topics: body.results?.topics?.segments ?? []
  };
}

function timecode(seconds) {
  const whole = Math.max(0, seconds);
  const hh = String(Math.floor(whole / 3600)).padStart(2, '0');
  const mm = String(Math.floor((whole % 3600) / 60)).padStart(2, '0');
  const ss = String(Math.floor(whole % 60)).padStart(2, '0');
  const ms = String(Math.round((whole % 1) * 1000)).padStart(3, '0');
  return `${hh}:${mm}:${ss},${ms}`;
}

// Group the word timings into short cues. Each cue is shown from its first
// word's start to its last word's end, so the captions track the speech.
function buildSrt(words) {
  const cues = [];

  for (let i = 0; i < words.length; i += CUE_WORDS) {
    const group = words.slice(i, i + CUE_WORDS);
    const text = group.map(word => word.punctuated_word ?? word.word).join(' ');
    cues.push(
      `${cues.length + 1}\n${timecode(group[0].start)} --> ${timecode(group.at(-1).end)}\n${text}\n`
    );
  }

  return cues.join('\n');
}

// One chapter per topic segment. Deepgram reports each segment as a word
// range, so the start time is the start of its first word.
function buildChapters(topics, words) {
  const chapters = [];

  for (const segment of topics) {
    const first = words[segment.start_word];
    const topic = segment.topics?.[0]?.topic;

    if (!first || !topic) {
      continue;
    }

    const last = chapters.at(-1);

    if (last && first.start - last.start < CHAPTER_SECONDS * 2) {
      continue;
    }

    chapters.push({ start: Number(first.start.toFixed(2)), title: topic });
  }

  return chapters;
}

async function main() {
  await mkdir('output', { recursive: true });
  const manifestPath = 'output/manifest.json';
  const manifest = await readManifest(manifestPath);
  const template = JSON.parse(await readFile('template.json', 'utf8'));

  if (manifest.jobs.chaptered?.status === 'done') {
    console.log(
      'Already rendered. Delete output/manifest.json to render again.'
    );
    return;
  }

  const cacheKey = fingerprint([sourceVideo, MODEL, 'transcript']);
  let transcript = manifest.cache[cacheKey];

  if (transcript) {
    console.log('Reusing the transcript from an earlier run');
  } else {
    console.log('Transcribing the recording with Deepgram');
    transcript = await transcribe();
    manifest.cache[cacheKey] = transcript;
    await writeManifest(manifestPath, manifest);
  }

  const srt = buildSrt(transcript.words);
  await writeFile('output/captions.srt', srt);
  const srtUrl = await uploadToShotstack(
    shotstackKey,
    srt,
    'application/x-subrip',
    'captions'
  );

  const chapters = buildChapters(transcript.topics, transcript.words);
  console.log(
    `Found ${chapters.length} chapters and ${transcript.words.length} words`
  );

  const edit = structuredClone(template);
  const chapterTrack = edit.timeline.tracks[1];
  const proto = chapterTrack.clips[0];
  chapterTrack.clips = chapters.map((chapter, index) => {
    const clip = structuredClone(proto);
    clip.asset.text = `${index + 1}. ${chapter.title}`;
    clip.start = chapter.start;
    clip.length = CHAPTER_SECONDS;
    return clip;
  });

  if (chapterTrack.clips.length === 0) {
    edit.timeline.tracks.splice(1, 1);
  }

  edit.merge = mergeFields({
    SOURCE_VIDEO: sourceVideo,
    SRT_URL: srtUrl,
    ACCENT: process.env.ACCENT || '#0CB5B2'
  });

  console.log('Rendering the chaptered, captioned video');
  const url = await renderEdit(shotstackKey, edit, 'chaptered video');
  const file = 'output/chaptered.mp4';
  await download(url, file);
  manifest.jobs.chaptered = {
    status: 'done',
    file,
    url,
    chapters,
    renderedAt: new Date().toISOString()
  };
  await writeManifest(manifestPath, manifest);
  console.log(
    `\nDone. The video is at ${file}. Captions are in output/captions.srt.`
  );
}

try {
  await main();
} catch (error) {
  console.error(error instanceof Error ? error.message : error);
  process.exit(1);
}
