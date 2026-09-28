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

const RECRAFT_URL = 'https://external.api.recraft.ai/v1/images/generations';
const RECRAFT_MODEL = process.env.RECRAFT_MODEL || 'recraftv4_1';
const RECRAFT_STYLE = process.env.RECRAFT_STYLE || 'digital_illustration';
const STYLE_ID = process.env.RECRAFT_STYLE_ID || '';
const FORMATS = [
  { name: '1x1', width: 1080, height: 1080, statSize: 200 },
  { name: '9x16', width: 1080, height: 1920, statSize: 220 }
];

const shotstackKey = requireEnv(
  'SHOTSTACK_API_KEY',
  'Get it from https://dashboard.shotstack.io.'
);
const recraftKey = requireEnv(
  'RECRAFT_API_KEY',
  'Get it from https://www.recraft.ai/profile/api.'
);

function hexToRgb(hex) {
  const clean = hex.replace('#', '');
  return [0, 2, 4].map(i => parseInt(clean.slice(i, i + 2), 16));
}

// One request per row. The brand palette goes in as preferred colours so
// every background sits with the same accent, and a custom style id keeps
// the illustration style consistent across the whole set.
async function generateBackground(prompt, colors, size) {
  const body = {
    prompt,
    model: RECRAFT_MODEL,
    size,
    n: 1,
    response_format: 'url',
    controls: { colors: colors.map(hex => ({ rgb: hexToRgb(hex) })) }
  };

  if (STYLE_ID) {
    body.style_id = STYLE_ID;
  } else {
    body.style = RECRAFT_STYLE;
  }

  const response = await request(
    RECRAFT_URL,
    {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${recraftKey}`,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify(body)
    },
    'Recraft'
  );
  const url = (await response.json()).data?.[0]?.url;

  if (!url) {
    throw new Error('Recraft returned no image.');
  }

  return url;
}

async function main() {
  const rows = parseCsv(await readFile('stats.csv', 'utf8'));

  if (rows.length === 0) {
    throw new Error('stats.csv has a header but no rows.');
  }

  const brand = JSON.parse(await readFile('brand.json', 'utf8'));
  await mkdir('output', { recursive: true });
  const manifestPath = 'output/manifest.json';
  const manifest = await readManifest(manifestPath);
  const template = JSON.parse(await readFile('template.json', 'utf8'));

  for (const row of rows) {
    const stat = Number(String(row.stat).replace(/[^0-9.]/g, ''));

    if (!Number.isFinite(stat)) {
      throw new Error(
        `Row ${row.id}: stat must be a number, got "${row.stat}".`
      );
    }

    for (const format of FORMATS) {
      const jobId = `${row.id}-${format.name}`;

      if (manifest.jobs[jobId]?.status === 'done') {
        console.log(`${jobId}: already rendered, skipping`);
        continue;
      }

      const size = format.name === '1x1' ? '1024x1024' : '768x1344';
      const cacheKey = fingerprint([
        row.prompt,
        brand.colors,
        STYLE_ID,
        RECRAFT_STYLE,
        RECRAFT_MODEL,
        size
      ]);
      let background = manifest.cache[cacheKey];

      if (background) {
        console.log(`${jobId}: reusing the background from an earlier run`);
      } else {
        console.log(`${jobId}: generating the background with Recraft`);
        const temporary = await generateBackground(
          row.prompt,
          brand.colors,
          size
        );
        const image = await request(temporary, {}, 'Recraft');
        background = await uploadToShotstack(
          shotstackKey,
          Buffer.from(await image.arrayBuffer()),
          'image/png',
          'background'
        );
        manifest.cache[cacheKey] = background;
        await writeManifest(manifestPath, manifest);
      }

      const edit = structuredClone(template);
      edit.output = {
        format: 'mp4',
        size: { width: format.width, height: format.height }
      };
      edit.merge = mergeFields({
        BACKGROUND: background,
        STAT: stat,
        STAT_SIZE: format.statSize,
        SUFFIX: row.suffix || '',
        LABEL: row.label,
        ACCENT: brand.accent
      });

      console.log(`${jobId}: rendering`);
      const url = await renderEdit(shotstackKey, edit, jobId);
      const file = `output/${jobId}.mp4`;
      await download(url, file);
      manifest.jobs[jobId] = {
        status: 'done',
        file,
        url,
        renderedAt: new Date().toISOString()
      };
      await writeManifest(manifestPath, manifest);
      console.log(`${jobId}: saved to ${file}`);
    }
  }

  console.log('\nDone. Two videos per stat in output/.');
}

try {
  await main();
} catch (error) {
  console.error(error instanceof Error ? error.message : error);
  process.exit(1);
}
