'use strict';

// Lädt die Champion-Liste von Riot Data Dragon, cached sie im Speicher und auf
// der Festplatte und fällt bei Netzwerkfehlern auf Cache bzw. eingebaute Liste zurück.

const fs = require('fs');
const path = require('path');

const DDRAGON = 'https://ddragon.leagueoflegends.com';
const CACHE_FILE = path.join(__dirname, '..', 'data', 'champions-cache.json');
const FALLBACK_FILE = path.join(__dirname, 'fallback-champions.json');
const FETCH_TIMEOUT_MS = 8000;
const REFRESH_INTERVAL_MS = 12 * 60 * 60 * 1000;

let current = null; // { version, source, champions: [{ id, name, title, tags, image }] }

async function fetchJson(url) {
  const res = await fetch(url, { signal: AbortSignal.timeout(FETCH_TIMEOUT_MS) });
  if (!res.ok) throw new Error(`HTTP ${res.status} für ${url}`);
  return res.json();
}

// Nur erwartete Felder übernehmen; Daten von außen werden nicht blind vertraut.
function normalize(version, raw) {
  const safeId = /^[A-Za-z0-9]{1,40}$/;
  const champions = Object.values(raw || {})
    .filter((c) => c && typeof c.id === 'string' && safeId.test(c.id) && typeof c.name === 'string')
    .map((c) => ({
      id: c.id,
      name: String(c.name).slice(0, 60),
      title: typeof c.title === 'string' ? c.title.slice(0, 80) : '',
      tags: Array.isArray(c.tags) ? c.tags.filter((t) => typeof t === 'string').slice(0, 4) : [],
      image: `${DDRAGON}/cdn/${version}/img/champion/${c.id}.png`,
    }))
    .sort((a, b) => a.name.localeCompare(b.name, 'de'));
  return champions;
}

async function loadFromNetwork() {
  const versions = await fetchJson(`${DDRAGON}/api/versions.json`);
  const version = Array.isArray(versions) ? versions[0] : null;
  if (typeof version !== 'string' || !/^[0-9.]{3,20}$/.test(version)) {
    throw new Error('Ungültige Versionsliste von Data Dragon');
  }
  const data = await fetchJson(`${DDRAGON}/cdn/${version}/data/de_DE/champion.json`);
  const champions = normalize(version, data && data.data);
  if (champions.length < 20) throw new Error('Champion-Liste unvollständig');
  return { version, source: 'ddragon', champions };
}

function loadFromFile(file, source) {
  try {
    const parsed = JSON.parse(fs.readFileSync(file, 'utf8'));
    if (!parsed || !Array.isArray(parsed.champions) || parsed.champions.length < 3) return null;
    const raw = {};
    for (const c of parsed.champions) raw[c.id] = c;
    return { version: parsed.version, source, champions: normalize(parsed.version, raw) };
  } catch {
    return null;
  }
}

function writeCache(result) {
  try {
    fs.mkdirSync(path.dirname(CACHE_FILE), { recursive: true });
    fs.writeFileSync(
      CACHE_FILE,
      JSON.stringify({
        version: result.version,
        savedAt: new Date().toISOString(),
        champions: result.champions.map(({ id, name, title, tags }) => ({ id, name, title, tags })),
      })
    );
  } catch (err) {
    console.warn('[champions] Cache konnte nicht geschrieben werden:', err.message);
  }
}

async function refresh() {
  try {
    const result = await loadFromNetwork();
    current = result;
    writeCache(result);
    console.log(`[champions] ${result.champions.length} Champions geladen (Patch ${result.version}).`);
  } catch (err) {
    console.warn('[champions] Data Dragon nicht erreichbar:', err.message);
    if (!current) {
      current = loadFromFile(CACHE_FILE, 'cache') || loadFromFile(FALLBACK_FILE, 'fallback');
      if (!current) throw new Error('Keine Champion-Daten verfügbar');
      console.log(`[champions] ${current.champions.length} Champions aus ${current.source} (Patch ${current.version}).`);
    }
  }
  return current;
}

async function init() {
  await refresh();
  const timer = setInterval(() => refresh().catch(() => {}), REFRESH_INTERVAL_MS);
  timer.unref();
  return current;
}

function getChampionData() {
  return current;
}

function getChampionById(id) {
  if (!current || typeof id !== 'string') return null;
  return current.champions.find((c) => c.id === id) || null;
}

module.exports = { init, getChampionData, getChampionById, normalize };
