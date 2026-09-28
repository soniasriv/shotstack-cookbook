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

const DID_URL = 'https://api.d-id.com';
const DID_VOICE = process.env.DID_VOICE || 'en-US-JennyNeural';
const SLIDE_GAP = 0.4;

const shotstackKey = requireEnv(
  'SHOTSTACK_API_KEY',
  'Get it from https://dashboard.shotstack.io.'
);
const didKey = requireEnv(
  'DID_API_KEY',
  'Get it from https://studio.d-id.com (Account Settings, API key).'
);
const presenterImage = requireEnv(
  'PRESENTER_IMAGE',
  'A public https link to a front-facing photo of the presenter.'
);

// D-ID uses HTTP Basic auth. The key from D-ID Studio is pasted as-is after
// the word Basic; do not base64-encode it again.
const didHeaders = {
  Authorization: `Basic ${didKey}`,
  'Content-Type': 'application/json',
  Accept: 'application/json'
};

async function createTalk(script) {
  const response = await request(
    `${DID_URL}/talks`,
    {
      method: 'POST',
      headers: didHeaders,
      body: JSON.stringify({
        source_url: presenterImage,
        script: {
          type: 'text',
          input: script,
          provider: { type: 'microsoft', voice_id: DID_VOICE }
        },
        config: { stitch: true, result_format: 'mp4' }
      })
    },
    'D-ID'
  );

  return (await response.json()).id;
}

async function waitForTalk(id) {
  const started = Date.now();

  while (Date.now() - started < MAX_WAIT_MS) {
    const poll = await request(
      `${DID_URL}/talks/${id}`,
      { headers: didHeaders },
      'D-ID'
    );
    const talk = await poll.json();

    if (talk.status === 'done' && talk.result_url) {
      return talk.result_url;
    }

    if (talk.status === 'error' || talk.status === 'rejected') {
      throw new Error(
        `D-ID could not make the talk: ${talk.error?.description ?? talk.status}`
      );
    }

    await delay(POLL_INTERVAL_MS);
  }

  throw new Error('D-ID did not finish the talk in time.');
}

// D-ID result links expire. The clip is copied to Shotstack so the render and
// any later re-render keep working.
async function hostClip(url, label) {
  const source = await request(url, {}, 'D-ID');
  const bytes = Buffer.from(await source.arrayBuffer());
  return uploadToShotstack(shotstackKey, bytes, 'video/mp4', label);
}

async function main() {
  const rows = parseCsv(await readFile('slides.csv', 'utf8'));

  if (rows.length === 0) {
    throw new Error('slides.csv has a header but no rows.');
  }

  await mkdir('output', { recursive: true });
  const manifestPath = 'output/manifest.json';
  const manifest = await readManifest(manifestPath);
  const template = JSON.parse(await readFile('template.json', 'utf8'));

  if (manifest.jobs.explainer?.status === 'done') {
    console.log(
      'Already rendered. Delete output/manifest.json to render again.'
    );
    return;
  }

  const talks = [];

  for (const [index, row] of rows.entries()) {
    const number = index + 1;
    const cacheKey = fingerprint([presenterImage, row.script, DID_VOICE]);
    let clipUrl = manifest.cache[cacheKey];

    if (clipUrl) {
      console.log(`slide ${number}: reusing the talk from an earlier run`);
    } else {
      console.log(
        `slide ${number}: asking D-ID to speak ${row.script.split(/\s+/).length} words`
      );
      const resultUrl = await waitForTalk(await createTalk(row.script));
      clipUrl = await hostClip(resultUrl, `talk for slide ${number}`);
      manifest.cache[cacheKey] = clipUrl;
      await writeManifest(manifestPath, manifest);
    }

    talks.push({ number, clipUrl, image: row.image_url });
  }

  // The template holds one slide. Copy its three clips (captions, presenter,
  // slide) once per row, chained with "auto" starts so each slide waits for
  // the talk before it to finish.
  const edit = structuredClone(template);
  const [captionTrack, talkTrack, slideTrack, textTrack] = edit.timeline.tracks;
  const captionProto = captionTrack.clips[0];
  const talkProto = talkTrack.clips[0];
  const slideProto = slideTrack.clips[0];
  captionTrack.clips = [];
  talkTrack.clips = [];
  slideTrack.clips = [];

  for (const talk of talks) {
    const alias = `talk-${talk.number}`;
    const first = talk.number === 1;

    const talkClip = structuredClone(talkProto);
    talkClip.alias = alias;
    talkClip.asset.src = talk.clipUrl;
    talkClip.start = first ? talkProto.start : 'auto';
    talkTrack.clips.push(talkClip);

    const slideClip = structuredClone(slideProto);
    slideClip.asset.src = talk.image;
    slideClip.start = `alias://${alias}`;
    slideClip.length = `alias://${alias}`;
    slideTrack.clips.push(slideClip);

    const captionClip = structuredClone(captionProto);
    captionClip.asset.src = `alias://${alias}`;
    captionClip.start = `alias://${alias}`;
    captionClip.length = `alias://${alias}`;
    captionTrack.clips.push(captionClip);
  }

  // The end card starts when the last talk ends: chain it on the talk track.
  const endCard = textTrack.clips.pop();
  endCard.start = 'auto';
  talkTrack.clips.push(endCard);

  edit.merge = mergeFields({
    TITLE: process.env.TITLE || 'Product walkthrough',
    END_CARD: process.env.END_CARD || 'Start free at shotstack.io'
  });

  console.log(
    `Rendering ${talks.length} slides with the presenter in the corner`
  );
  const url = await renderEdit(shotstackKey, edit, 'explainer');
  const file = 'output/explainer.mp4';
  await download(url, file);
  manifest.jobs.explainer = {
    status: 'done',
    file,
    url,
    slides: talks.length,
    renderedAt: new Date().toISOString()
  };
  await writeManifest(manifestPath, manifest);
  console.log(`\nDone. The video is at ${file}.`);
}

try {
  await main();
} catch (error) {
  console.error(error instanceof Error ? error.message : error);
  process.exit(1);
}
