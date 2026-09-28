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

const CAMB_URL = 'https://client.camb.ai/apis';
const CAMB_POLL_MS = 30_000;
const CAMB_MAX_WAIT_MS = 60 * 60 * 1_000;

const shotstackKey = requireEnv(
  'SHOTSTACK_API_KEY',
  'Get it from https://dashboard.shotstack.io.'
);
const cambKey = requireEnv(
  'CAMB_API_KEY',
  'Get it from https://studio.camb.ai (API keys).'
);
const sourceVideo = requireEnv(
  'SOURCE_VIDEO',
  'A public https link to the video to localise.'
);
const sourceLanguage = process.env.SOURCE_LANGUAGE || 'en-us';

const cambHeaders = {
  'x-api-key': cambKey,
  'Content-Type': 'application/json',
  Accept: 'application/json'
};

// One dubbing task per target language, so each language gets its own
// run id and result, and a failure in one language does not stop the rest.
async function startDub(targetLanguage) {
  const response = await request(
    `${CAMB_URL}/dub`,
    {
      method: 'POST',
      headers: cambHeaders,
      body: JSON.stringify({
        video_url: sourceVideo,
        source_language: sourceLanguage,
        target_languages: [targetLanguage],
        transcription_mode: 'fast'
      })
    },
    'Camb.ai'
  );
  const { task_id: taskId } = await response.json();

  if (!taskId) {
    throw new Error('Camb.ai did not return a task id.');
  }

  return taskId;
}

async function waitForDub(taskId) {
  const started = Date.now();

  while (Date.now() - started < CAMB_MAX_WAIT_MS) {
    const poll = await request(
      `${CAMB_URL}/dub/${taskId}`,
      { headers: cambHeaders },
      'Camb.ai'
    );
    const task = await poll.json();

    if (task.status === 'SUCCESS' && task.run_id) {
      const result = await request(
        `${CAMB_URL}/dub-result/${task.run_id}`,
        { headers: cambHeaders },
        'Camb.ai'
      );
      return result.json();
    }

    if (['ERROR', 'TIMEOUT', 'PAYMENT_REQUIRED'].includes(task.status)) {
      throw new Error(`Camb.ai dubbing stopped with status ${task.status}.`);
    }

    await delay(CAMB_POLL_MS);
  }

  throw new Error('Camb.ai did not finish the dub in time.');
}

function timecode(seconds) {
  const whole = Math.max(0, seconds);
  const hh = String(Math.floor(whole / 3600)).padStart(2, '0');
  const mm = String(Math.floor((whole % 3600) / 60)).padStart(2, '0');
  const ss = String(Math.floor(whole % 60)).padStart(2, '0');
  const ms = String(Math.round((whole % 1) * 1000)).padStart(3, '0');
  return `${hh}:${mm}:${ss},${ms}`;
}

// Camb.ai returns the translated dialogue with timings, so the captions are
// the real translation, not a transcription of the dubbed audio.
function buildSrt(transcript) {
  return transcript
    .map((line, index) => {
      return `${index + 1}\n${timecode(line.start)} --> ${timecode(line.end)}\n${line.text.trim()}\n`;
    })
    .join('\n');
}

async function hostAudio(url, label) {
  const source = await request(url, {}, 'Camb.ai');
  const bytes = Buffer.from(await source.arrayBuffer());
  return uploadToShotstack(shotstackKey, bytes, 'audio/mpeg', label);
}

async function main() {
  const rows = parseCsv(await readFile('languages.csv', 'utf8'));

  if (rows.length === 0) {
    throw new Error('languages.csv has a header but no rows.');
  }

  await mkdir('output', { recursive: true });
  const manifestPath = 'output/manifest.json';
  const manifest = await readManifest(manifestPath);
  const template = JSON.parse(await readFile('template.json', 'utf8'));

  for (const row of rows) {
    if (manifest.jobs[row.language]?.status === 'done') {
      console.log(`${row.language}: already rendered, skipping`);
      continue;
    }

    const cacheKey = fingerprint([sourceVideo, sourceLanguage, row.language]);
    let dub = manifest.cache[cacheKey];

    if (dub) {
      console.log(`${row.language}: reusing the dub from an earlier run`);
    } else {
      console.log(`${row.language}: asking Camb.ai to dub the video`);
      const result = await waitForDub(await startDub(row.language));

      if (!result.audio_url || !Array.isArray(result.transcript)) {
        throw new Error(
          `${row.language}: Camb.ai returned no audio or transcript.`
        );
      }

      const audioUrl = await hostAudio(result.audio_url, `${row.language} dub`);
      const srt = buildSrt(result.transcript);
      await writeFile(`output/${row.language}.srt`, srt);
      const srtUrl = await uploadToShotstack(
        shotstackKey,
        srt,
        'application/x-subrip',
        `${row.language} captions`
      );
      dub = { audioUrl, srtUrl, lines: result.transcript.length };
      manifest.cache[cacheKey] = dub;
      await writeManifest(manifestPath, manifest);
    }

    const edit = structuredClone(template);
    edit.merge = mergeFields({
      SOURCE_VIDEO: sourceVideo,
      DUB_URL: dub.audioUrl,
      SRT_URL: dub.srtUrl,
      LANGUAGE_LABEL: row.label || row.language,
      ACCENT: process.env.ACCENT || '#0CB5B2'
    });

    console.log(`${row.language}: rendering with ${dub.lines} caption lines`);
    const url = await renderEdit(shotstackKey, edit, row.language);
    const file = `output/${row.language}.mp4`;
    await download(url, file);
    manifest.jobs[row.language] = {
      status: 'done',
      file,
      url,
      renderedAt: new Date().toISOString()
    };
    await writeManifest(manifestPath, manifest);
    console.log(`${row.language}: saved to ${file}`);
  }

  console.log('\nDone. One localised video per language in output/.');
}

try {
  await main();
} catch (error) {
  console.error(error instanceof Error ? error.message : error);
  process.exit(1);
}
