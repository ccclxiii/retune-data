/**
 * The daily robot for ReTune's Greek podcasts list (GitHub Actions runs it every morning).
 *
 * In: greek-shows.json, our list of Greek shows in two groups ("first": the most listened,
 * "then": the rest), and podcast companies whose shows carry each maker's own name.
 * Out: popular-gr.json, what the app shows first as "Δημοφιλή" for Greece and Cyprus.
 *
 * Every day it reads each show's own feed (its name, cover, categories, newest episode). In each
 * group the newest episode comes first. A show without an episode for 45 days goes to the end;
 * after 180 days it's left out. (Podcast Index's "trending" can't tell which Greek shows are
 * rising: in Nov 2026 it gave every one of them the same score, so it isn't used here.)
 *
 * node podcasts/build.mjs
 */
import { readFile, writeFile } from 'node:fs/promises';
import { XMLParser } from 'fast-xml-parser';

const HERE = new URL('./', import.meta.url);
const LIST = new URL('greek-shows.json', HERE);
const OUT = new URL('popular-gr.json', HERE);

const DAY = 86_400_000;
const RESTING_DAYS = 45;
const GONE_DAYS = 180;
const FEEDS_AT_ONCE = 6;
const TIMEOUT_MS = 25_000;
const AGENT = 'ReTune data robot (+https://retuneradio.github.io)';

const parser = new XMLParser({
  ignoreAttributes: false,
  attributeNamePrefix: '@_',
  textNodeName: '#text',
  parseTagValue: false,
  parseAttributeValue: false,
  trimValues: true,
  processEntities: true,
  htmlEntities: true,
  isArray: name => name === 'item' || name === 'itunes:category',
});

const isNode = value => typeof value === 'object' && value !== null && !Array.isArray(value);

function text(value) {
  if (Array.isArray(value)) return text(value[0]);
  if (typeof value === 'string' || typeof value === 'number') return String(value).trim();
  if (isNode(value) && value['#text'] !== undefined) return text(value['#text']);
  return '';
}

function attribute(value, name) {
  const node = Array.isArray(value) ? value[0] : value;
  return isNode(node) ? text(node[`@_${name}`]) : '';
}

const web = value => (/^https?:\/\/\S+$/i.test(value.trim()) ? value.trim() : undefined);

/** One feed address however it's written (http/https, a slash at the end, capitals). */
const feedKey = url => url.trim().replace(/^http:/i, 'https:').replace(/\/+$/, '').toLowerCase();

const MONTHS = ['jan', 'feb', 'mar', 'apr', 'may', 'jun', 'jul', 'aug', 'sep', 'oct', 'nov', 'dec'];
const ZONES = { GMT: 0, UT: 0, UTC: 0, Z: 0, CET: 60, CEST: 120, EET: 120, EEST: 180, EST: -300, EDT: -240, PST: -480, PDT: -420 };

/** As the app reads a feed's dates ("Tue, 18 Nov 2026 07:00:00 EET", "+0200", ISO): ms, 0 when unreadable. */
function readDate(value) {
  const match = /(\d{1,2})\s+([a-z]{3})[a-z]*\.?\s+(\d{2,4})(?:\s+(\d{1,2}):(\d{2})(?::(\d{2}))?)?\s*([+-]\d{2}:?\d{2}|[a-z]{1,4})?/i.exec(value);
  if (match) {
    const month = MONTHS.indexOf(match[2].toLowerCase());
    let year = Number(match[3]);
    if (year < 100) year += year < 70 ? 2000 : 1900;
    if (month >= 0) {
      const zone = match[7] ?? 'GMT';
      let offset = ZONES[zone.toUpperCase()] ?? 0;
      const numeric = /^([+-])(\d{2}):?(\d{2})$/.exec(zone);
      if (numeric) offset = (numeric[1] === '-' ? -1 : 1) * (Number(numeric[2]) * 60 + Number(numeric[3]));
      return Date.UTC(year, month, Number(match[1]), Number(match[4] ?? 0), Number(match[5] ?? 0), Number(match[6] ?? 0)) - offset * 60_000;
    }
  }
  const iso = Date.parse(value);
  return Number.isFinite(iso) ? iso : 0;
}

/** The categories as Podcast Index names them: "Society & Culture" → Society, Culture (the app's chips). */
function categoriesOf(channel) {
  const names = [];
  const walk = list => {
    for (const node of Array.isArray(list) ? list : []) {
      names.push(...attribute(node, 'text').split('&').map(name => name.trim()).filter(Boolean));
      if (isNode(node)) walk(node['itunes:category']);
    }
  };
  walk(channel['itunes:category']);
  return [...new Set(names)];
}

async function get(url) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
  try {
    const response = await fetch(url, { headers: { 'User-Agent': AGENT }, signal: controller.signal, redirect: 'follow' });
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    return await response.text();
  } finally {
    clearTimeout(timer);
  }
}

/** A show's own feed, read: what the app's list needs. Null when it isn't a podcast feed (or hides itself). */
async function readShow(url) {
  const xml = await get(url);
  const channel = parser.parse(xml.replace(/<!DOCTYPE[^[>]*(\[[\s\S]*?\])?\s*>/gi, ''))?.rss?.channel;
  if (!isNode(channel) || text(channel['itunes:block']).toLowerCase() === 'yes') return null;
  const items = Array.isArray(channel.item) ? channel.item.filter(isNode) : [];
  const newest = Math.max(0, ...items.map(item => readDate(text(item.pubDate))));
  const image = web(attribute(channel['itunes:image'], 'href')) ?? web(text(isNode(channel.image) ? channel.image.url : ''));
  const movedTo = web(text(channel['itunes:new-feed-url']));
  if (movedTo && feedKey(movedTo) !== feedKey(url)) console.log(`moved: ${url} → ${movedTo} (change it in greek-shows.json)`);
  return {
    feed: movedTo && feedKey(movedTo) !== feedKey(url) ? movedTo : url,
    title: text(channel.title) || text(channel['itunes:title']),
    author: text(channel['itunes:author']) || text(channel['podcast:author']) || text(channel.managingEditor),
    ...(image ? { image } : {}),
    language: text(channel.language).toLowerCase(),
    categories: categoriesOf(channel),
    newest,
  };
}

/** Each feed read, a few at a time; a feed that fails today keeps yesterday's details. */
async function readAll(urls, yesterday) {
  const read = new Map();
  const waiting = [...new Set(urls)];
  const worker = async () => {
    for (let url = waiting.shift(); url; url = waiting.shift()) {
      try {
        const show = await readShow(url);
        if (show) read.set(url, show);
        else console.log(`left out (not a podcast feed, or hidden): ${url}`);
      } catch (error) {
        const before = yesterday.get(feedKey(url));
        console.log(`couldn't read ${url} (${error.message})${before ? ': kept as yesterday' : ''}`);
        if (before) read.set(url, before);
      }
    }
  };
  await Promise.all(Array.from({ length: FEEDS_AT_ONCE }, worker));
  return read;
}

const plain = value => String(value ?? '').normalize('NFD').replace(/\p{M}/gu, '').toLowerCase().trim();
const nameKey = show => `${plain(show.title)}|${plain(show.author)}`;

async function main() {
  const list = JSON.parse(await readFile(LIST, 'utf8'));
  const before = await readFile(OUT, 'utf8').then(JSON.parse, () => null);
  const yesterday = new Map(
    [...(before?.shows ?? []), ...(before?.companies ?? []).flatMap(company => company.shows)].map(show => [feedKey(show.feed), show]),
  );
  const groups = [list.shows.first, list.shows.then];
  const read = await readAll([...groups.flat(), ...list.companies.flatMap(company => company.feeds)], yesterday);

  const now = Date.now();
  const age = show => (show.newest ? (now - show.newest) / DAY : Infinity);
  // Each show once (the same show at two addresses, or twice on the list).
  const seen = new Set();
  const once = show => {
    const keys = [feedKey(show.feed), nameKey(show)];
    if (keys.some(key => seen.has(key))) return false;
    keys.forEach(key => seen.add(key));
    return true;
  };
  const newestFirst = shows => [...shows].sort((a, b) => b.newest - a.newest);

  const shown = groups.map(group => group.map(url => read.get(url)).filter(show => show && age(show) <= GONE_DAYS && once(show)));
  const shows = [
    ...shown.flatMap(group => newestFirst(group.filter(show => age(show) <= RESTING_DAYS))),
    ...shown.flatMap(group => group.filter(show => age(show) > RESTING_DAYS)),
  ];
  // A company's picture: its own, else its first show's cover; its shows, the newest episode first.
  const companies = list.companies.map(company => {
    const image = company.image ?? read.get(company.feeds[0])?.image;
    return {
      name: company.name,
      ...(image ? { image } : {}),
      shows: newestFirst(company.feeds.map(url => read.get(url)).filter(Boolean)),
    };
  });

  const content = { version: 1, shows, companies };
  const { updated: _updated, ...beforeContent } = before ?? {};
  if (before && JSON.stringify(beforeContent) === JSON.stringify(content)) {
    console.log('no change');
    return;
  }
  await writeFile(OUT, `${JSON.stringify({ version: 1, updated: new Date(now).toISOString(), shows, companies }, null, 1)}\n`);
  const resting = shows.filter(show => age(show) > RESTING_DAYS).length;
  console.log(`${shows.length} shows (${resting} resting at the end), ${companies.length} companies`);
}

await main();
