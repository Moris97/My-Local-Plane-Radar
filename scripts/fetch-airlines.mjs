import { mkdir, writeFile } from 'node:fs/promises';

// OpenFlights airlines.dat: ODbL data (not the AGPL-licensed OpenFlights
// code -- we only ever touch this one data file, never any of their
// scripts). Columns: id, name, alias, IATA, ICAO, callsign, country, active.
// Verified live against the current file before writing this parser.
const AIRLINES_URL = 'https://raw.githubusercontent.com/jpatokal/openflights/master/data/airlines.dat';
const OUTPUT_PATH = new URL('../data/airlines.json', import.meta.url);

// Hand-written CSV-row parser: airline names can contain commas inside
// quotes (e.g. "Korean Air Lines Co., Ltd."), so a plain .split(',') would
// misparse those rows. No new dependency for this -- it's a small, one-shot
// install-time script.
function parseCsvLine(line) {
  const fields = [];
  let current = '';
  let inQuotes = false;

  for (let i = 0; i < line.length; i++) {
    const char = line[i];
    if (inQuotes) {
      if (char === '"') {
        if (line[i + 1] === '"') {
          current += '"';
          i++;
        } else {
          inQuotes = false;
        }
      } else {
        current += char;
      }
    } else if (char === '"') {
      inQuotes = true;
    } else if (char === ',') {
      fields.push(current);
      current = '';
    } else {
      current += char;
    }
  }
  fields.push(current);
  return fields;
}

function isNullField(value) {
  return value === '' || value === '\\N';
}

async function main() {
  console.log('Fetching OpenFlights airlines.dat...');
  const response = await fetch(AIRLINES_URL);
  if (!response.ok) {
    throw new Error(`Failed to fetch airlines.dat: HTTP ${response.status}`);
  }
  const text = await response.text();

  const airlines = {};
  let kept = 0;
  let total = 0;

  for (const line of text.split('\n')) {
    if (!line.trim()) continue;
    total++;

    const fields = parseCsvLine(line);
    const [, name, , , icao, , country, active] = fields;

    if (active !== 'Y') continue;
    if (isNullField(icao)) continue;

    airlines[icao] = { name, country: isNullField(country) ? null : country };
    kept++;
  }

  await mkdir(new URL('.', OUTPUT_PATH), { recursive: true });
  await writeFile(OUTPUT_PATH, JSON.stringify(airlines));
  console.log(`Wrote data/airlines.json (${kept} active airlines out of ${total} total entries).`);
  console.log('Source: OpenFlights (https://openflights.org), data licensed ODbL.');
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
