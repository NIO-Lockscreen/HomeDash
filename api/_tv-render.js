// The TV screensaver: the family calendar as a set of 16:9 pictures for the
// TCL's Google TV ambient mode, which plays an album as a slideshow.
//
//   buildTvPlan()   - the slides the album should hold, in order: the
//                     overview of today, a full-screen picture for every task
//                     left this week, then for each following week its own
//                     overview and its tasks. Each slide carries a model -
//                     plain JSON of what it shows - and a hash of it.
//   renderTvSlide() - draws one model as a 3840x2160 JPEG with satori + resvg.
//
// A slide is only uploaded again when its hash changes, so the models avoid
// anything that moves on its own: a task's picture says "Thursday 3
// December", never "tomorrow", and nothing depends on the hour. Only today's
// overview changes with the date, so that is the one daily upload.
//
// The pictures leave out the time and the weather on purpose. Google TV draws
// its own live clock and weather over ambient mode, and the bottom-right
// corner is kept quiet for that overlay (and for TVs that overscan).
import crypto from 'crypto';
import satori from 'satori';
import { Resvg } from '@resvg/resvg-js';
import jpeg from 'jpeg-js';
import { INTER_600, INTER_800, INTER_900, GELASIO_400, GELASIO_600 } from './_tv-fonts.js';
import { expandEventOccurrences, zonedParts, zonedDateTimeToUtc, dateKeyInTimeZone } from './_reminders.js';

// Bump when the look changes, so the next run draws and uploads a new picture
// even though no task changed.
export const TV_LAYOUT_VERSION = 'tv-2026-11-26-a';
// 16:9 at 4K UHD, the TCL's panel. Google TV scales it down cleanly on a
// 1080p set; the opposite would look soft on a 4K one.
export const TV_WIDTH = 3840;
export const TV_HEIGHT = 2160;
const DESIGN_WIDTH = 1920;
const S = TV_WIDTH / DESIGN_WIDTH;
const px = value => Math.round(value * S * 100) / 100;

const UPCOMING_CARDS = 4;
const LOOKAHEAD_DAYS = 365;
const IMAGE_FETCH_TIMEOUT_MS = 6000;
const IMAGE_MAX_BYTES = 8 * 1024 * 1024;
const DAY_MS = 24 * 60 * 60 * 1000;
// JPEG, not PNG: about 0.8 MB instead of 3 MB with photos, and Google keeps
// every upload at original quality against the account's storage, even the
// old snapshots taken out of the album. 90 keeps the text clean.
const JPEG_QUALITY = 90;

const COLORS = {
  ink: '#2f2b27',
  muted: '#81786e',
  line: 'rgba(87, 78, 67, 0.12)'
};

const LABELS = {
  en: {
    today: 'Today',
    tomorrow: 'Tomorrow',
    week: 'Week',
    upcoming: 'Upcoming',
    nothingUpcoming: 'Nothing else planned',
    emptyHero: 'Enjoy each day',
    updated: 'Updated',
    nextWeek: 'Next week',
    inWeeks: count => `In ${count} weeks`,
    more: count => `+${count} more`
  },
  nb: {
    today: 'I dag',
    tomorrow: 'I morgen',
    week: 'Uke',
    upcoming: 'Kommende',
    nothingUpcoming: 'Ingenting mer planlagt',
    emptyHero: 'Nyt hver dag',
    updated: 'Oppdatert',
    nextWeek: 'Neste uke',
    inWeeks: count => `Om ${count} uker`,
    more: count => `+${count} til`
  }
};

export function tvLanguage() {
  const value = String(process.env.TV_LANGUAGE || 'en').trim().toLowerCase();
  return value === 'nb' || value === 'no' || value === 'nn' ? 'nb' : 'en';
}

function timeZone() {
  return process.env.ORGANIZER_TIME_ZONE || 'Europe/Oslo';
}

function locale(language) {
  return language === 'nb' ? 'nb-NO' : 'en-US';
}

function capitalize(text) {
  return text ? text.charAt(0).toLocaleUpperCase() + text.slice(1) : text;
}

function format(date, language, options) {
  return new Intl.DateTimeFormat(locale(language), { timeZone: timeZone(), ...options }).format(date);
}

// "Thu" / "Tor" - the short weekday, without the trailing dot Norwegian adds.
function shortWeekday(date, language) {
  return capitalize(format(date, language, { weekday: 'short' }).replace(/\.$/, ''));
}

function clockTime(date) {
  return new Intl.DateTimeFormat('en-GB', { timeZone: timeZone(), hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }).format(date);
}

// Noon on a calendar day in the organizer's zone: a safe anchor for names.
function localNoon(parts) {
  return zonedDateTimeToUtc(parts.year, parts.month, parts.day, 12, 0);
}

function addDays(parts, days) {
  const date = new Date(Date.UTC(parts.year, parts.month - 1, parts.day + days, 12));
  return { year: date.getUTCFullYear(), month: date.getUTCMonth() + 1, day: date.getUTCDate() };
}

function keyOf(parts) {
  return `${parts.year}-${String(parts.month).padStart(2, '0')}-${String(parts.day).padStart(2, '0')}`;
}

// 0 = Monday ... 6 = Sunday.
function mondayIndex(parts) {
  return (new Date(Date.UTC(parts.year, parts.month - 1, parts.day)).getUTCDay() + 6) % 7;
}

function isoWeek(parts) {
  const date = new Date(Date.UTC(parts.year, parts.month - 1, parts.day));
  const thursday = new Date(date);
  thursday.setUTCDate(date.getUTCDate() + 3 - mondayIndex(parts));
  const firstThursday = new Date(Date.UTC(thursday.getUTCFullYear(), 0, 4));
  firstThursday.setUTCDate(firstThursday.getUTCDate() + 3 - ((firstThursday.getUTCDay() + 6) % 7));
  return 1 + Math.round((thursday - firstThursday) / (7 * DAY_MS));
}

function endOfNextMonth(parts) {
  // The first day of the month after next, minus a millisecond.
  const year = parts.month >= 11 ? parts.year + 1 : parts.year;
  const month = ((parts.month + 1) % 12) + 1;
  return new Date(zonedDateTimeToUtc(year, month, 1, 0, 0).getTime() - 1);
}

function cleanPercent(value, fallback) {
  const number = Number(value);
  return Number.isFinite(number) ? Math.max(0, Math.min(100, Math.round(number * 10) / 10)) : fallback;
}

function cleanZoom(value) {
  const number = Number(value);
  return Number.isFinite(number) ? Math.max(1, Math.min(1.8, Math.round(number * 100) / 100)) : 1.01;
}

function imageOf(master) {
  const url = String(master?.imageUrl || '').trim();
  if (!/^https:\/\//i.test(url)) return null;
  return {
    url,
    focusX: cleanPercent(master.imageFocusX, 50),
    focusY: cleanPercent(master.imageFocusY, 38),
    zoom: cleanZoom(master.imageZoom),
    width: Number(master.imageNaturalWidth) > 0 ? Number(master.imageNaturalWidth) : 0,
    height: Number(master.imageNaturalHeight) > 0 ? Number(master.imageNaturalHeight) : 0
  };
}

function kickerFor(start, todayKey, tomorrowKey, language) {
  const labels = LABELS[language];
  const key = dateKeyInTimeZone(start);
  const time = clockTime(start);
  if (todayKey && key === todayKey) return `${labels.today} · ${time}`;
  if (tomorrowKey && key === tomorrowKey) return `${labels.tomorrow} · ${time}`;
  return `${shortDate(start, language)} · ${time}`;
}

// "Thu Dec 3" / "Tor 3. des"
function shortDate(date, language) {
  return language === 'nb'
    ? `${shortWeekday(date, language)} ${format(date, language, { day: 'numeric' }).replace(/\.$/, '')}. ${shortMonth(date, language)}`
    : `${shortWeekday(date, language)} ${shortMonth(date, language)} ${format(date, language, { day: 'numeric' })}`;
}

function shortMonth(date, language) {
  return format(date, language, { month: 'short' }).replace(/\.$/, '');
}

// "Thursday 3 December" / "Torsdag 3. desember"
function longDate(date, language) {
  const weekday = capitalize(format(date, language, { weekday: 'long' }));
  const day = format(date, language, { day: 'numeric' }).replace(/\.$/, '');
  const month = format(date, language, { month: 'long' });
  return language === 'nb' ? `${weekday} ${day}. ${month}` : `${weekday} ${day} ${capitalize(month)}`;
}

function weekRange(mondayParts, language) {
  const first = localNoon(mondayParts);
  const last = localNoon(addDays(mondayParts, 6));
  const day = date => format(date, language, { day: 'numeric' }).replace(/\.$/, '');
  return language === 'nb'
    ? `${day(first)}. ${shortMonth(first, language)} – ${day(last)}. ${shortMonth(last, language)}`
    : `${shortMonth(first, language)} ${day(first)} – ${shortMonth(last, language)} ${day(last)}`;
}

// A task with no end is taken as over an hour after it starts.
const DEFAULT_DURATION_MS = 60 * 60 * 1000;

function collectOccurrences(events, rangeStart, rangeEnd, repeatCutoff) {
  const masters = new Map();
  const occurrences = [];
  for (const event of Array.isArray(events) ? events : []) {
    // Work tasks only ever show on a screen in work mode; the TV is not one.
    if (!event?.id || String(event.scope || 'family') === 'work') continue;
    masters.set(String(event.id), event);
    for (const occurrence of expandEventOccurrences(event, rangeStart, rangeEnd)) {
      const start = new Date(occurrence.start);
      if (Number.isNaN(start.getTime())) continue;
      // Repeating tasks further out than the end of next month stay hidden,
      // as on the wall, or a weekly practice would fill everything.
      if ((event.repeat || 'none') !== 'none' && start > repeatCutoff) continue;
      const end = occurrence.end ? new Date(occurrence.end) : null;
      occurrences.push({
        ...occurrence,
        master: event,
        startDate: start,
        endDate: end && !Number.isNaN(end.getTime()) && end > start ? end : null,
        until: end && !Number.isNaN(end.getTime()) && end > start ? end : new Date(start.getTime() + DEFAULT_DURATION_MS),
        dayKey: dateKeyInTimeZone(start)
      });
    }
  }
  occurrences.sort((a, b) => a.startDate - b.startDate || String(a.title).localeCompare(String(b.title)));
  return { masters, occurrences };
}

function card(item, todayKey, tomorrowKey, language) {
  return {
    id: String(item.eventId),
    title: String(item.title || '').trim(),
    kicker: kickerFor(item.startDate, todayKey, tomorrowKey, language),
    location: String(item.location || '').trim(),
    image: imageOf(item.master)
  };
}

function weekRow(mondayParts, busyDays, todayKey, language) {
  return Array.from({ length: 7 }, (_, index) => {
    const parts = addDays(mondayParts, index);
    const key = keyOf(parts);
    return { key, name: shortWeekday(localNoon(parts), language), day: parts.day, today: key === todayKey, busy: busyDays.has(key) };
  });
}

// Today's overview: the date, this week and next, the big task, the next
// four - the wall display reflowed to 16:9, without the clock and weather.
function overviewModel({ occurrences, today, monday, todayStart, language }) {
  const labels = LABELS[language];
  const todayKey = keyOf(today);
  const tomorrowKey = keyOf(addDays(today, 1));
  const busyDays = new Set(occurrences.map(item => item.dayKey));
  // From the start of today, like the wall: a task earlier today still
  // belongs to today. The overview never depends on the hour.
  const ahead = occurrences.filter(item => item.startDate >= todayStart);
  const todays = ahead.filter(item => item.dayKey === todayKey);
  const hero = todays.find(item => item.master?.featured) || todays[0] || ahead[0] || null;
  const rest = ahead.filter(item => item !== hero);
  return {
    kind: 'overview',
    layout: TV_LAYOUT_VERSION,
    language,
    dateKey: todayKey,
    date: {
      big: String(today.day),
      heading: capitalize(format(localNoon(today), language, { weekday: 'long' })),
      sub: `${capitalize(format(localNoon(today), language, { month: 'long' }))} ${today.year}`,
      stripLabel: `${labels.week} ${isoWeek(today)} / ${isoWeek(addDays(monday, 7))}`
    },
    weeks: [weekRow(monday, busyDays, todayKey, language), weekRow(addDays(monday, 7), busyDays, todayKey, language)],
    hero: hero ? card(hero, todayKey, tomorrowKey, language) : null,
    upcoming: rest.slice(0, UPCOMING_CARDS).map(item => card(item, todayKey, tomorrowKey, language)),
    moreCount: Math.max(0, rest.length - UPCOMING_CARDS)
  };
}

// The overview of a later week: what that week holds, with plain dates so
// it stays the same picture all week.
function weekModel({ occurrences, weekMonday, weekIndex, language }) {
  const labels = LABELS[language];
  const weekKeys = new Set(Array.from({ length: 7 }, (_, index) => keyOf(addDays(weekMonday, index))));
  const inWeek = occurrences.filter(item => weekKeys.has(item.dayKey));
  const busyDays = new Set(inWeek.map(item => item.dayKey));
  const hero = inWeek.find(item => item.master?.featured) || inWeek[0] || null;
  const rest = inWeek.filter(item => item !== hero);
  return {
    kind: 'week',
    layout: TV_LAYOUT_VERSION,
    language,
    weekKey: keyOf(weekMonday),
    date: {
      big: String(isoWeek(weekMonday)),
      heading: weekIndex === 1 ? labels.nextWeek : labels.inWeeks(weekIndex),
      sub: weekRange(weekMonday, language),
      stripLabel: `${labels.week} ${isoWeek(weekMonday)}`
    },
    weeks: [weekRow(weekMonday, busyDays, '', language)],
    hero: hero ? card(hero, '', '', language) : null,
    upcoming: rest.slice(0, UPCOMING_CARDS).map(item => card(item, '', '', language)),
    moreCount: Math.max(0, rest.length - UPCOMING_CARDS)
  };
}

// One task, full screen.
function eventModel(item, language) {
  const start = item.startDate;
  const time = item.endDate && dateKeyInTimeZone(item.endDate) === item.dayKey
    ? `${clockTime(start)}–${clockTime(item.endDate)}`
    : clockTime(start);
  const note = String(item.note || '').replace(/\s+/g, ' ').trim();
  return {
    kind: 'event',
    layout: TV_LAYOUT_VERSION,
    language,
    id: String(item.eventId),
    title: String(item.title || '').trim(),
    when: `${longDate(start, language)} · ${time}`,
    location: String(item.location || '').trim(),
    note: note.length > 180 ? `${note.slice(0, 177).trimEnd()}…` : note,
    image: imageOf(item.master),
    tile: {
      weekday: shortWeekday(start, language).toUpperCase(),
      day: format(start, language, { day: 'numeric' }).replace(/\.$/, ''),
      month: shortMonth(start, language).toUpperCase()
    }
  };
}

export function tvModelHash(model) {
  return crypto.createHash('sha256').update(JSON.stringify(model)).digest('hex');
}

export function tvWeeks() {
  const value = Number(process.env.TV_WEEKS);
  return Number.isInteger(value) && value >= 1 && value <= 4 ? value : 2;
}

// Never more pictures than this in the album, so a busy fortnight cannot
// turn into a long upload or a pile of snapshots in the library.
export const MAX_SLIDES = 40;

// The slides the album should hold right now, in slideshow order. Each is
// { key, kind, model, hash, until? }: `until` is when a task's picture is
// taken out again (its end, or an hour after its start).
export function buildTvPlan({ events, now = new Date(), language = tvLanguage(), weeks = tvWeeks() }) {
  const today = zonedParts(now);
  const monday = addDays(today, -mondayIndex(today));
  const rangeStart = zonedDateTimeToUtc(monday.year, monday.month, monday.day, 0, 0);
  const todayStart = zonedDateTimeToUtc(today.year, today.month, today.day, 0, 0);
  const rangeEnd = new Date(todayStart.getTime() + LOOKAHEAD_DAYS * DAY_MS);
  const { occurrences } = collectOccurrences(events, rangeStart, rangeEnd, endOfNextMonth(today));

  const slides = [];
  const add = (key, model, until = null) => {
    if (slides.length >= MAX_SLIDES) return;
    slides.push({ key, kind: model.kind, model, hash: tvModelHash(model), until: until ? until.toISOString() : null });
  };

  add('overview', overviewModel({ occurrences, today, monday, todayStart, language }));
  for (let week = 0; week < weeks; week += 1) {
    const weekMonday = addDays(monday, week * 7);
    const weekStart = zonedDateTimeToUtc(weekMonday.year, weekMonday.month, weekMonday.day, 0, 0);
    const nextMonday = addDays(weekMonday, 7);
    const weekEnd = zonedDateTimeToUtc(nextMonday.year, nextMonday.month, nextMonday.day, 0, 0);
    // Tasks not over yet. A task that has ended leaves the album on the next
    // hourly check.
    const tasks = occurrences.filter(item => item.startDate >= weekStart && item.startDate < weekEnd && item.until > now);
    if (week > 0) {
      if (!tasks.length) continue;
      add(`week:${keyOf(weekMonday)}`, weekModel({ occurrences, weekMonday, weekIndex: week, language }));
    }
    for (const item of tasks) {
      add(`event:${item.eventId}:${item.dayKey}:${clockTime(item.startDate)}`, eventModel(item, language), item.until);
    }
  }
  return slides;
}

// ---------------------------------------------------------------------------
// Drawing

// satori takes React-like elements; every box with children is a flex box.
function h(type, style = {}, ...children) {
  const kids = children.flat().filter(child => child !== null && child !== undefined && child !== false && child !== '');
  return {
    type,
    props: {
      style: type === 'div' ? { display: 'flex', boxSizing: 'border-box', ...style } : style,
      children: kids.length === 0 ? undefined : kids.length === 1 ? kids[0] : kids
    }
  };
}

function img(src, style) {
  return { type: 'img', props: { src, style, width: style.width, height: style.height } };
}

// The wall's calm placeholder for a task without a photo, picked the same
// way from the task id, so the TV shows the same art as the wall.
const PLACEHOLDERS = [
  { a: '#dad2c4', b: '#a89c8b', c: '#655b50', motif: 'plant' },
  { a: '#e7dfd2', b: '#b9c4bf', c: '#6e7c73', motif: 'horizon' },
  { a: '#eee6dc', b: '#d1b99f', c: '#806a55', motif: 'coffee' },
  { a: '#e2e8e4', b: '#a9bdb8', c: '#667a74', motif: 'waves' },
  { a: '#eadfd5', b: '#cab5a2', c: '#795f4e', motif: 'table' }
];

function placeholderSvg(seed) {
  const index = Math.abs([...String(seed || 'Calm')].reduce((sum, char) => sum + char.charCodeAt(0), 0)) % PLACEHOLDERS.length;
  const p = PLACEHOLDERS[index];
  const motif = {
    plant: `<path d="M310 310 C310 240 278 192 230 153" stroke="${p.c}" stroke-width="5" fill="none" stroke-linecap="round" opacity=".58"/><path d="M231 154 C211 132 174 128 162 151 C190 161 216 165 231 154Z" fill="${p.c}" opacity=".45"/><path d="M270 205 C250 178 213 176 197 198 C225 212 251 217 270 205Z" fill="${p.c}" opacity=".35"/><path d="M306 252 C334 224 376 224 390 249 C358 264 327 268 306 252Z" fill="${p.c}" opacity=".34"/>`,
    horizon: `<path d="M0 265 C115 210 228 330 350 260 C450 202 526 235 640 190 L640 420 L0 420Z" fill="${p.b}" opacity=".55"/><circle cx="475" cy="130" r="46" fill="#fff8ed" opacity=".7"/>`,
    coffee: `<ellipse cx="315" cy="300" rx="175" ry="34" fill="${p.c}" opacity=".16"/><rect x="235" y="175" width="120" height="95" rx="20" fill="#fff8ed" opacity=".68"/><path d="M354 198 h23 c35 0 35 48 0 48 h-23" stroke="#fff8ed" stroke-width="18" fill="none" opacity=".68"/><path d="M265 150 C255 128 286 124 274 101 M311 151 C301 126 335 126 322 99" stroke="${p.c}" stroke-width="5" fill="none" opacity=".32"/>`,
    waves: `<path d="M0 235 C70 205 120 265 190 235 S310 205 380 235 S505 265 640 220 V420 H0Z" fill="${p.b}" opacity=".5"/><path d="M0 295 C80 260 135 330 215 295 S355 260 435 295 S550 330 640 285" stroke="#fff8ed" stroke-width="10" fill="none" opacity=".55"/>`,
    table: `<rect x="135" y="245" width="370" height="16" rx="8" fill="${p.c}" opacity=".35"/><rect x="170" y="260" width="22" height="78" rx="10" fill="${p.c}" opacity=".22"/><rect x="450" y="260" width="22" height="78" rx="10" fill="${p.c}" opacity=".22"/><circle cx="300" cy="203" r="48" fill="#fff8ed" opacity=".45"/><path d="M362 183 C405 172 439 189 463 222" stroke="${p.c}" stroke-width="9" fill="none" opacity=".24"/>`
  }[p.motif];
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 640 420" width="640" height="420"><defs><linearGradient id="g" x1="0" x2="1" y1="0" y2="1"><stop stop-color="${p.a}"/><stop offset="1" stop-color="${p.b}"/></linearGradient></defs><rect width="640" height="420" fill="url(#g)"/><circle cx="105" cy="80" r="130" fill="#fff8ed" opacity=".26"/>${motif}</svg>`;
  return { src: `data:image/svg+xml;base64,${Buffer.from(svg).toString('base64')}`, width: 640, height: 420 };
}

// The pixel size of a JPEG, PNG, GIF or WebP, read from its header.
function imageSize(bytes) {
  const b = bytes;
  if (b.length > 24 && b[0] === 0x89 && b[1] === 0x50) return { type: 'image/png', width: b.readUInt32BE(16), height: b.readUInt32BE(20) };
  if (b.length > 10 && b[0] === 0x47 && b[1] === 0x49) return { type: 'image/gif', width: b.readUInt16LE(6), height: b.readUInt16LE(8) };
  if (b.length > 30 && b.toString('ascii', 0, 4) === 'RIFF' && b.toString('ascii', 8, 12) === 'WEBP') {
    const chunk = b.toString('ascii', 12, 16);
    if (chunk === 'VP8X') return { type: 'image/webp', width: 1 + b.readUIntLE(24, 3), height: 1 + b.readUIntLE(27, 3) };
    if (chunk === 'VP8L') {
      const bits = b.readUInt32LE(21);
      return { type: 'image/webp', width: 1 + (bits & 0x3fff), height: 1 + ((bits >> 14) & 0x3fff) };
    }
    if (chunk === 'VP8 ') return { type: 'image/webp', width: b.readUInt16LE(26) & 0x3fff, height: b.readUInt16LE(28) & 0x3fff };
    return null;
  }
  if (b.length > 4 && b[0] === 0xff && b[1] === 0xd8) {
    let offset = 2;
    while (offset + 9 < b.length) {
      if (b[offset] !== 0xff) { offset += 1; continue; }
      const marker = b[offset + 1];
      if (marker === 0xd8 || marker === 0x01 || (marker >= 0xd0 && marker <= 0xd7)) { offset += 2; continue; }
      const length = b.readUInt16BE(offset + 2);
      // Start-of-frame markers carry the size; C4, C8 and CC do not.
      if (marker >= 0xc0 && marker <= 0xcf && ![0xc4, 0xc8, 0xcc].includes(marker)) {
        return { type: 'image/jpeg', width: b.readUInt16BE(offset + 7), height: b.readUInt16BE(offset + 5) };
      }
      offset += 2 + length;
    }
  }
  return null;
}

async function fetchImage(url) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), IMAGE_FETCH_TIMEOUT_MS);
  try {
    const response = await fetch(url, { signal: controller.signal });
    if (!response.ok) return null;
    const bytes = Buffer.from(await response.arrayBuffer());
    if (!bytes.length || bytes.length > IMAGE_MAX_BYTES) return null;
    const size = imageSize(bytes);
    // resvg draws JPEG, PNG and GIF. Anything else gets the placeholder.
    if (!size || !size.width || !size.height || size.type === 'image/webp') return null;
    return { src: `data:${size.type};base64,${bytes.toString('base64')}`, width: size.width, height: size.height };
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
}

// The photo cropped like the wall crops it: cover the frame, put the focus
// point where object-position would, then zoom about that point.
function photo(source, image, frameWidth, frameHeight) {
  const fx = (image?.focusX ?? 50) / 100;
  const fy = (image?.focusY ?? 38) / 100;
  const zoom = image?.zoom ?? 1.01;
  const cover = Math.max(frameWidth / source.width, frameHeight / source.height);
  const width = source.width * cover;
  const height = source.height * cover;
  const left0 = (frameWidth - width) * fx;
  const top0 = (frameHeight - height) * fy;
  const ox = fx * frameWidth;
  const oy = fy * frameHeight;
  return img(source.src, {
    position: 'absolute',
    left: ox + zoom * (left0 - ox),
    top: oy + zoom * (top0 - oy),
    width: width * zoom,
    height: height * zoom
  });
}

function weekTile(day) {
  return h('div', {
    flexDirection: 'column',
    alignItems: 'center',
    justifyContent: 'center',
    width: px(70),
    height: px(92),
    borderRadius: px(18),
    border: `${px(1)}px solid ${day.today ? 'rgba(47,43,39,0.18)' : COLORS.line}`,
    background: day.today ? 'rgba(47,43,39,0.9)' : day.busy ? 'rgba(255,255,255,0.78)' : 'rgba(255,255,255,0.5)',
    color: day.today ? 'rgba(255,255,255,0.72)' : COLORS.muted
  },
  h('div', { fontFamily: 'Inter', fontWeight: 900, fontSize: px(14), letterSpacing: px(1.2) }, day.name.toUpperCase()),
  h('div', { fontFamily: 'Gelasio', fontWeight: 400, fontSize: px(36), lineHeight: 1, letterSpacing: px(-1.6), marginTop: px(4), color: day.today ? '#ffffff' : COLORS.ink }, String(day.day)),
  h('div', { width: px(7), height: px(7), marginTop: px(6), borderRadius: px(4), background: day.busy ? 'currentColor' : 'transparent', opacity: 0.75 })
  );
}

function dateCard(model, width, height) {
  const { date, weeks } = model;
  return h('div', {
    flexDirection: 'column',
    justifyContent: 'center',
    alignItems: 'center',
    width,
    height,
    borderRadius: px(28),
    background: 'rgba(255,255,255,0.62)',
    border: `${px(1.5)}px solid rgba(154,128,98,0.16)`,
    color: COLORS.ink
  },
  h('div', { alignItems: 'center' },
    h('div', { fontFamily: 'Gelasio', fontWeight: 400, fontSize: px(230), lineHeight: 0.86, letterSpacing: px(-16) }, date.big),
    h('div', { flexDirection: 'column', marginLeft: px(34) },
      h('div', { fontFamily: 'Gelasio', fontWeight: 600, fontSize: px(58), lineHeight: 1, letterSpacing: px(-2) }, date.heading),
      h('div', { fontFamily: 'Inter', fontWeight: 600, fontSize: px(28), color: COLORS.muted, marginTop: px(14) }, date.sub)
    )
  ),
  h('div', { fontFamily: 'Inter', fontWeight: 900, fontSize: px(17), letterSpacing: px(2.4), color: COLORS.muted, marginTop: px(46) }, date.stripLabel.toUpperCase()),
  ...weeks.map((week, row) => h('div', { gap: px(10), marginTop: px(row === 0 ? 16 : 10) }, ...week.map(weekTile)))
  );
}

function heroCard(model, sources, width, height) {
  const labels = LABELS[model.language];
  const hero = model.hero;
  const source = (hero?.image && sources.get(hero.image.url)) || placeholderSvg(hero?.id || 'Calm');
  return h('div', {
    position: 'relative',
    width,
    height,
    borderRadius: px(28),
    overflow: 'hidden',
    background: '#d9cfc1'
  },
  photo(source, hero?.image, width, height),
  h('div', { position: 'absolute', left: 0, top: 0, width, height, backgroundImage: 'linear-gradient(180deg, rgba(0,0,0,0.04) 15%, rgba(0,0,0,0.6) 100%)' }),
  h('div', {
    position: 'absolute',
    left: px(44),
    bottom: px(40),
    width: width - px(88),
    flexDirection: 'column',
    color: '#ffffff'
  },
  hero ? h('div', { fontFamily: 'Inter', fontWeight: 900, fontSize: px(22), letterSpacing: px(1.8), opacity: 0.92, marginBottom: px(12) }, hero.kicker.toUpperCase()) : null,
  h('div', { display: 'block', fontFamily: 'Gelasio', fontWeight: 600, fontSize: px(80), lineHeight: 1, letterSpacing: px(-3.4), lineClamp: 2, maxWidth: width * 0.78 }, hero ? hero.title : labels.emptyHero),
  hero?.location ? h('div', { fontFamily: 'Inter', fontWeight: 600, fontSize: px(28), marginTop: px(16), opacity: 0.92 }, hero.location) : null
  ));
}

function upcomingCard(item, sources, width, height) {
  const source = (item.image && sources.get(item.image.url)) || placeholderSvg(item.id);
  return h('div', {
    position: 'relative',
    width,
    height,
    borderRadius: px(18),
    overflow: 'hidden',
    background: '#d9cfc1',
    boxShadow: `0 ${px(6)}px ${px(10)}px rgba(70,58,44,0.10)`
  },
  photo(source, item.image, width, height),
  h('div', { position: 'absolute', left: 0, top: 0, width, height, backgroundImage: 'linear-gradient(180deg, rgba(0,0,0,0.02) 0%, rgba(0,0,0,0.12) 34%, rgba(0,0,0,0.82) 100%)' }),
  h('div', {
    position: 'absolute',
    left: px(22),
    bottom: px(20),
    width: width - px(44),
    flexDirection: 'column',
    color: '#ffffff'
  },
  h('div', { fontFamily: 'Inter', fontWeight: 900, fontSize: px(18), letterSpacing: px(0.8), opacity: 0.92, marginBottom: px(6) }, item.kicker.toUpperCase()),
  h('div', { display: 'block', fontFamily: 'Inter', fontWeight: 900, fontSize: px(28), lineHeight: 1.12, lineClamp: 2 }, item.title)
  ));
}

function upcomingRow(model, sources, width, height) {
  const labels = LABELS[model.language];
  const gap = px(20);
  const titleHeight = px(40);
  const cardHeight = height - titleHeight;
  const cardWidth = (width - gap * (UPCOMING_CARDS - 1)) / UPCOMING_CARDS;
  const cards = model.upcoming.map(item => upcomingCard(item, sources, cardWidth, cardHeight));
  return h('div', { flexDirection: 'column', width, height },
    h('div', { justifyContent: 'space-between', alignItems: 'flex-start', height: titleHeight, fontFamily: 'Inter', fontWeight: 900, fontSize: px(17), letterSpacing: px(2), color: COLORS.muted },
      h('div', {}, labels.upcoming.toUpperCase()),
      model.moreCount ? h('div', {}, labels.more(model.moreCount).toUpperCase()) : null
    ),
    cards.length
      ? h('div', { gap }, ...cards)
      : h('div', {
        alignItems: 'center',
        justifyContent: 'center',
        width,
        height: cardHeight,
        borderRadius: px(18),
        background: 'rgba(255,255,255,0.5)',
        border: `${px(1)}px solid ${COLORS.line}`,
        fontFamily: 'Gelasio',
        fontSize: px(40),
        color: COLORS.muted
      }, labels.nothingUpcoming)
  );
}

function layout(model, sources, renderedAt) {
  const labels = LABELS[model.language];
  // A 16:9 shell like the wall's 3:2 one. The band below it stays quiet:
  // it is where Google TV may draw its own clock and weather.
  const shell = { left: px(48), top: px(40), width: px(1824), height: px(928), padding: px(28) };
  const innerWidth = shell.width - shell.padding * 2;
  const innerHeight = shell.height - shell.padding * 2;
  const gap = px(24);
  const bottomHeight = px(300);
  const topHeight = innerHeight - gap - bottomHeight;
  const dateWidth = px(640);
  const heroWidth = innerWidth - gap - dateWidth;
  const updated = `${labels.updated} ${shortWeekday(renderedAt, model.language)} ${clockTime(renderedAt)}`;

  return h('div', {
    position: 'relative',
    width: TV_WIDTH,
    height: TV_HEIGHT,
    backgroundColor: '#f2ebe2',
    backgroundImage: 'radial-gradient(circle at 20% 0%, rgba(255,255,255,0.92), rgba(255,255,255,0) 32%), linear-gradient(135deg, #f7f1e9 0%, #ede4d8 100%)'
  },
  h('div', {
    position: 'absolute',
    left: shell.left,
    top: shell.top,
    width: shell.width,
    height: shell.height,
    padding: shell.padding,
    flexDirection: 'column',
    borderRadius: px(38),
    background: 'rgba(255,255,255,0.46)',
    border: `${px(1.5)}px solid rgba(255,255,255,0.7)`
  },
  h('div', { gap, height: topHeight },
    dateCard(model, dateWidth, topHeight),
    heroCard(model, sources, heroWidth, topHeight)
  ),
  h('div', { marginTop: gap }, upcomingRow(model, sources, innerWidth, bottomHeight))
  ),
  h('div', {
    position: 'absolute',
    left: px(76),
    top: px(1004),
    fontFamily: 'Inter',
    fontWeight: 800,
    fontSize: px(18),
    letterSpacing: px(1.6),
    color: 'rgba(129,120,110,0.75)'
  }, `HOMEDASH · ${updated.toUpperCase()}`)
  );
}

// One task, full screen: its photo edge to edge, a calendar leaf top left,
// and the words bottom left. The bottom-right corner stays clear for the
// TV's own clock.
function eventLayout(model, sources) {
  const source = (model.image && sources.get(model.image.url)) || placeholderSvg(model.id);
  const tile = model.tile;
  return h('div', { position: 'relative', width: TV_WIDTH, height: TV_HEIGHT, overflow: 'hidden', background: '#2f2b27' },
    photo(source, model.image, TV_WIDTH, TV_HEIGHT),
    h('div', { position: 'absolute', left: 0, top: 0, width: TV_WIDTH, height: TV_HEIGHT, backgroundImage: 'linear-gradient(90deg, rgba(0,0,0,0.62) 0%, rgba(0,0,0,0.30) 48%, rgba(0,0,0,0) 78%)' }),
    h('div', { position: 'absolute', left: 0, top: 0, width: TV_WIDTH, height: TV_HEIGHT, backgroundImage: 'linear-gradient(180deg, rgba(0,0,0,0.18) 0%, rgba(0,0,0,0) 30%, rgba(0,0,0,0) 50%, rgba(0,0,0,0.62) 100%)' }),
    h('div', {
      position: 'absolute',
      left: px(96),
      top: px(84),
      width: px(150),
      flexDirection: 'column',
      alignItems: 'center',
      borderRadius: px(26),
      overflow: 'hidden',
      background: 'rgba(255,250,242,0.94)',
      color: COLORS.ink
    },
    h('div', { width: px(150), justifyContent: 'center', paddingTop: px(12), paddingBottom: px(10), background: 'rgba(47,43,39,0.9)', color: '#ffffff', fontFamily: 'Inter', fontWeight: 900, fontSize: px(20), letterSpacing: px(2) }, tile.weekday),
    h('div', { fontFamily: 'Gelasio', fontWeight: 400, fontSize: px(88), lineHeight: 1, letterSpacing: px(-4), marginTop: px(8) }, tile.day),
    h('div', { fontFamily: 'Inter', fontWeight: 900, fontSize: px(20), letterSpacing: px(2), color: COLORS.muted, marginTop: px(2), marginBottom: px(14) }, tile.month)
    ),
    h('div', {
      position: 'absolute',
      left: px(96),
      bottom: px(110),
      width: px(1180),
      flexDirection: 'column',
      color: '#ffffff'
    },
    h('div', { fontFamily: 'Inter', fontWeight: 900, fontSize: px(30), letterSpacing: px(2), opacity: 0.94, marginBottom: px(18) }, model.when.toUpperCase()),
    h('div', { display: 'block', fontFamily: 'Gelasio', fontWeight: 600, fontSize: px(124), lineHeight: 1, letterSpacing: px(-5), lineClamp: 2 }, model.title),
    model.location ? h('div', { fontFamily: 'Inter', fontWeight: 800, fontSize: px(38), marginTop: px(26), opacity: 0.95 }, model.location) : null,
    model.note ? h('div', { display: 'block', fontFamily: 'Inter', fontWeight: 600, fontSize: px(28), lineHeight: 1.3, marginTop: px(16), opacity: 0.82, lineClamp: 2, maxWidth: px(1000) }, model.note) : null
    )
  );
}

function fontList() {
  const font = (name, data, weight) => ({ name, data: Buffer.from(data, 'base64'), weight, style: 'normal' });
  return [
    font('Inter', INTER_600, 600),
    font('Inter', INTER_800, 800),
    font('Inter', INTER_900, 900),
    font('Gelasio', GELASIO_400, 400),
    font('Gelasio', GELASIO_600, 600)
  ];
}

// Emoji in a task title are drawn from Twemoji. A title whose emoji cannot be
// fetched is still drawn, without them.
const emojiCache = new Map();
function emojiCode(segment) {
  const codes = [...segment].map(char => char.codePointAt(0).toString(16));
  // Twemoji names drop the variation selector unless the emoji needs it.
  return (codes.includes('200d') ? codes : codes.filter(code => code !== 'fe0f')).join('-');
}

async function loadEmoji(segment) {
  const code = emojiCode(segment);
  if (emojiCache.has(code)) return emojiCache.get(code);
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 3000);
  try {
    const response = await fetch(`https://cdn.jsdelivr.net/gh/jdecked/twemoji@15.1.0/assets/svg/${code}.svg`, { signal: controller.signal });
    const value = response.ok ? `data:image/svg+xml;base64,${Buffer.from(await response.text()).toString('base64')}` : '';
    emojiCache.set(code, value);
    return value;
  } catch {
    return '';
  } finally {
    clearTimeout(timer);
  }
}

// Draws one slide's model. Returns { jpeg, width, height, bytes }.
export async function renderTvSlide(model, { renderedAt = new Date() } = {}) {
  const urls = (model.kind === 'event' ? [model] : [model.hero, ...(model.upcoming || [])]).map(item => item?.image?.url).filter(Boolean);
  const sources = new Map();
  await Promise.all([...new Set(urls)].map(async url => {
    const source = await fetchImage(url);
    if (source) sources.set(url, source);
  }));

  const tree = model.kind === 'event' ? eventLayout(model, sources) : layout(model, sources, renderedAt);
  const svg = await satori(tree, {
    width: TV_WIDTH,
    height: TV_HEIGHT,
    fonts: fontList(),
    loadAdditionalAsset: async (code, segment) => (code === 'emoji' ? loadEmoji(segment) : [])
  });
  const raster = new Resvg(svg, {
    fitTo: { mode: 'original' },
    font: { loadSystemFonts: false },
    shapeRendering: 2
  }).render();
  const encoded = jpeg.encode({ data: raster.pixels, width: raster.width, height: raster.height }, JPEG_QUALITY);
  const bytes = Buffer.from(encoded.data);
  return { jpeg: bytes, width: raster.width, height: raster.height, bytes: bytes.length, photosDrawn: sources.size };
}
