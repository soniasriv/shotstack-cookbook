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

const HEYGEN_URL = 'https://api.heygen.com';
const HEYGEN_VOICE = process.env.HEYGEN_VOICE_ID;
const HEYGEN_AVATAR = process.env.HEYGEN_AVATAR_ID;

const shotstackKey = requireEnv(
  'SHOTSTACK_API_KEY',
  'Get it from https://dashboard.shotstack.io.'
);
const heygenKey = requireEnv(
  'HEYGEN_API_KEY',
  'Get it from https://app.heygen.com/settings (API).'
);
requireEnv('HEYGEN_AVATAR_ID', 'Pick one at https://app.heygen.com/avatars.');
requireEnv('HEYGEN_VOICE_ID', 'Pick one at https://app.heygen.com/voices.');

const heygenHeaders = {
  'X-Api-Key': heygenKey,
  'Content-Type': 'application/json',
  Accept: 'application/json'
};

async function createAvatarVideo(text) {
  const response = await request(
    `${HEYGEN_URL}/v2/video/generate`,
    {
      method: 'POST',
      headers: heygenHeaders,
      body: JSON.stringify({
        title: 'Catalog intro',
        video_inputs: [
          {
            character: {
              type: 'avatar',
              avatar_id: HEYGEN_AVATAR,
              avatar_style: 'normal'
            },
            voice: { type: 'text', input_text: text, voice_id: HEYGEN_VOICE },
            background: { type: 'color', value: '#000000' }
          }
        ],
        dimension: { width: 1080, height: 1920 }
      })
    },
    'HeyGen'
  );
  const body = await response.json();

  if (!body.data?.video_id) {
    throw new Error(
      `HeyGen did not return a video id: ${JSON.stringify(body).slice(0, 200)}`
    );
  }

  return body.data.video_id;
}

async function waitForAvatarVideo(videoId) {
  const started = Date.now();

  while (Date.now() - started < MAX_WAIT_MS) {
    const poll = await request(
      `${HEYGEN_URL}/v1/video_status.get?video_id=${videoId}`,
      { headers: heygenHeaders },
      'HeyGen'
    );
    const { data } = await poll.json();

    if (data.status === 'completed' && data.video_url) {
      return data.video_url;
    }

    if (data.status === 'failed') {
      throw new Error(
        `HeyGen could not make the video: ${JSON.stringify(data.error ?? '')}`
      );
    }

    await delay(POLL_INTERVAL_MS);
  }

  throw new Error('HeyGen did not finish the video in time.');
}

// HeyGen links expire after seven days. The intro is copied to Shotstack
// once, so every product video and every re-run uses a permanent link.
async function hostIntro(url) {
  const source = await request(url, {}, 'HeyGen');
  const bytes = Buffer.from(await source.arrayBuffer());
  return uploadToShotstack(shotstackKey, bytes, 'video/mp4', 'avatar intro');
}

async function main() {
  const rows = parseCsv(await readFile('products.csv', 'utf8'));

  if (rows.length === 0) {
    throw new Error('products.csv has a header but no rows.');
  }

  const introText = (await readFile('intro.txt', 'utf8')).trim();
  await mkdir('output', { recursive: true });
  const manifestPath = 'output/manifest.json';
  const manifest = await readManifest(manifestPath);
  const template = JSON.parse(await readFile('template.json', 'utf8'));

  const cacheKey = fingerprint([introText, HEYGEN_AVATAR, HEYGEN_VOICE]);
  let introUrl = manifest.cache[cacheKey];

  if (introUrl) {
    console.log('Reusing the avatar intro from an earlier run');
  } else {
    console.log('Asking HeyGen for the avatar intro');
    const videoUrl = await waitForAvatarVideo(
      await createAvatarVideo(introText)
    );
    introUrl = await hostIntro(videoUrl);
    manifest.cache[cacheKey] = introUrl;
    await writeManifest(manifestPath, manifest);
  }

  for (const row of rows) {
    if (manifest.jobs[row.id]?.status === 'done') {
      console.log(`${row.id}: already rendered, skipping`);
      continue;
    }

    const edit = structuredClone(template);
    edit.merge = mergeFields({
      INTRO_URL: introUrl,
      PRODUCT_NAME: row.name,
      PRICE: row.price,
      CTA: row.cta || 'Shop now',
      ACCENT: row.accent || '#0CB5B2',
      IMG1: row.image_1,
      IMG2: row.image_2 || row.image_1,
      IMG3: row.image_3 || row.image_1
    });

    console.log(`${row.id}: rendering`);
    const url = await renderEdit(shotstackKey, edit, row.id);
    const file = `output/${row.id}.mp4`;
    await download(url, file);
    manifest.jobs[row.id] = {
      status: 'done',
      file,
      url,
      name: row.name,
      renderedAt: new Date().toISOString()
    };
    await writeManifest(manifestPath, manifest);
    console.log(`${row.id}: saved to ${file}`);
  }

  console.log('\nDone. One video per product in output/.');
}

try {
  await main();
} catch (error) {
  console.error(error instanceof Error ? error.message : error);
  process.exit(1);
}
