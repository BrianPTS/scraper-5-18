/**
 * Timezone Utilities for Event Location-Based Time Handling
 *
 * Resolution pipeline (fastest → slowest):
 *   1. In-memory cache (process-level Map)
 *   2. MongoDB VenueTimezone collection (persistent across restarts)
 *   3. Static maps (venue names, city-timezones library, state codes, fragments)
 *   4. Geocoding: Nominatim (OpenStreetMap) → TimeAPI.io coordinate → timezone
 *   5. Longitude-based estimation (last resort if coordinate API is down)
 *
 * Once resolved, results are persisted to MongoDB — each unique venue is only
 * ever geocoded once. Random re-verification (2% chance if > 30 days old)
 * keeps data fresh without excessive API calls.
 *
 * Rate limiting: max 1 geocode request per 1.1 seconds (Nominatim policy).
 */

import cityTimezones from 'city-timezones';
import { getAccurateNow } from './timeSync';

// Lazy-import to avoid circular dependency issues at module level
// eslint-disable-next-line @typescript-eslint/no-explicit-any
let _VenueTimezone: any = null;
async function getVenueTimezoneModel() {
  if (!_VenueTimezone) {
    const mod = await import('../models/venueTimezoneModel.js');
    _VenueTimezone = mod.VenueTimezone;
  }
  return _VenueTimezone;
}

export const US_TIMEZONES = [
  { value: 'America/New_York', label: 'Eastern Time (ET)', abbr: 'ET' },
  { value: 'America/Chicago', label: 'Central Time (CT)', abbr: 'CT' },
  { value: 'America/Denver', label: 'Mountain Time (MT)', abbr: 'MT' },
  { value: 'America/Los_Angeles', label: 'Pacific Time (PT)', abbr: 'PT' },
  { value: 'America/Anchorage', label: 'Alaska Time (AKT)', abbr: 'AKT' },
  { value: 'Pacific/Honolulu', label: 'Hawaii Time (HT)', abbr: 'HT' },
] as const;

export type USTimezone = typeof US_TIMEZONES[number]['value'];

// ══════════════════════════════════════════════════════════════════════════════
// TIMEZONE NAME NORMALIZATION
// ══════════════════════════════════════════════════════════════════════════════

const TIMEZONE_NORMALIZE_MAP: Record<string, string> = {
  // Eastern Time variants
  'America/Detroit': 'America/New_York',
  'America/Toronto': 'America/New_York',
  'America/Montreal': 'America/New_York',
  'America/Nassau': 'America/New_York',
  'America/Iqaluit': 'America/New_York',
  'America/Nipigon': 'America/New_York',
  'America/Thunder_Bay': 'America/New_York',
  'America/Pangnirtung': 'America/New_York',
  'America/Indiana/Indianapolis': 'America/New_York',
  'America/Indiana/Marengo': 'America/New_York',
  'America/Indiana/Vevay': 'America/New_York',
  'America/Kentucky/Louisville': 'America/New_York',
  'America/Kentucky/Monticello': 'America/New_York',

  // Central Time variants
  'America/Winnipeg': 'America/Chicago',
  'America/Regina': 'America/Chicago',
  'America/Rainy_River': 'America/Chicago',
  'America/Rankin_Inlet': 'America/Chicago',
  'America/Resolute': 'America/Chicago',
  'America/Menominee': 'America/Chicago',
  'America/Indiana/Knox': 'America/Chicago',
  'America/Indiana/Tell_City': 'America/Chicago',
  'America/North_Dakota/Center': 'America/Chicago',
  'America/North_Dakota/New_Salem': 'America/Chicago',
  'America/North_Dakota/Beulah': 'America/Chicago',
  'America/Matamoros': 'America/Chicago',

  // Mountain Time variants
  'America/Phoenix': 'America/Denver',
  'America/Edmonton': 'America/Denver',
  'America/Boise': 'America/Denver',
  'America/Cambridge_Bay': 'America/Denver',
  'America/Yellowknife': 'America/Denver',
  'America/Inuvik': 'America/Denver',
  'America/Ojinaga': 'America/Denver',

  // Pacific Time variants
  'America/Vancouver': 'America/Los_Angeles',
  'America/Dawson_Creek': 'America/Los_Angeles',
  'America/Tijuana': 'America/Los_Angeles',
  'America/Whitehorse': 'America/Los_Angeles',

  // Alaska
  'America/Juneau': 'America/Anchorage',
  'America/Sitka': 'America/Anchorage',
  'America/Yakutat': 'America/Anchorage',
  'America/Nome': 'America/Anchorage',
  'America/Metlakatla': 'America/Anchorage',

  // Hawaii
  'Pacific/Johnston': 'Pacific/Honolulu',
};

function normalizeTimezone(tz: string): string {
  return TIMEZONE_NORMALIZE_MAP[tz] || tz;
}

// ══════════════════════════════════════════════════════════════════════════════
// CITY-TIMEZONES LIBRARY INDEX
// ══════════════════════════════════════════════════════════════════════════════

interface CityEntry {
  city: string;
  province: string;
  iso2: string;
  pop: number;
  timezone: string;
}

function normalizeText(s: string): string {
  return s.normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase().trim();
}

const CITY_INDEX = buildCityIndex();

function buildCityIndex(): Map<string, CityEntry[]> {
  const index = new Map<string, CityEntry[]>();

  for (const c of cityTimezones.cityMapping) {
    const entry: CityEntry = {
      city: c.city,
      province: c.province || '',
      iso2: c.iso2,
      pop: c.pop || 0,
      timezone: c.timezone,
    };

    const fullName = normalizeText(c.city);
    if (!index.has(fullName)) index.set(fullName, []);
    index.get(fullName)!.push(entry);

    const mainPart = normalizeText(c.city.split(/[,.]/)[0]);
    if (mainPart !== fullName && mainPart.length > 2) {
      if (!index.has(mainPart)) index.set(mainPart, []);
      index.get(mainPart)!.push(entry);
    }

    if (c.city_ascii) {
      const asciiName = normalizeText(c.city_ascii);
      if (asciiName !== fullName && asciiName.length > 2) {
        if (!index.has(asciiName)) index.set(asciiName, []);
        index.get(asciiName)!.push(entry);
      }
    }
  }

  for (const [, entries] of index) {
    entries.sort((a, b) => {
      const countryRank = (iso: string) => iso === 'US' ? 0 : iso === 'CA' ? 1 : 2;
      const rankDiff = countryRank(a.iso2) - countryRank(b.iso2);
      if (rankDiff !== 0) return rankDiff;
      return b.pop - a.pop;
    });
  }

  return index;
}

function lookupCityTimezone(cityName: string): string | null {
  const normalized = normalizeText(cityName);
  const entries = CITY_INDEX.get(normalized);
  if (entries && entries.length > 0) {
    return normalizeTimezone(entries[0].timezone);
  }
  return null;
}

// ══════════════════════════════════════════════════════════════════════════════
// STATE / PROVINCE ABBREVIATION MAP
// ══════════════════════════════════════════════════════════════════════════════

const STATE_TIMEZONE_MAP: Record<string, string> = {
  // Eastern Time
  'ct': 'America/New_York', 'connecticut': 'America/New_York',
  'de': 'America/New_York', 'delaware': 'America/New_York',
  'fl': 'America/New_York', 'florida': 'America/New_York',
  'ga': 'America/New_York', 'georgia': 'America/New_York',
  'in': 'America/New_York', 'indiana': 'America/New_York',
  'ky': 'America/New_York', 'kentucky': 'America/New_York',
  'me': 'America/New_York', 'maine': 'America/New_York',
  'md': 'America/New_York', 'maryland': 'America/New_York',
  'ma': 'America/New_York', 'massachusetts': 'America/New_York',
  'mi': 'America/New_York', 'michigan': 'America/New_York',
  'nh': 'America/New_York', 'new hampshire': 'America/New_York',
  'nj': 'America/New_York', 'new jersey': 'America/New_York',
  'ny': 'America/New_York', 'new york': 'America/New_York',
  'nc': 'America/New_York', 'north carolina': 'America/New_York',
  'oh': 'America/New_York', 'ohio': 'America/New_York',
  'pa': 'America/New_York', 'pennsylvania': 'America/New_York',
  'ri': 'America/New_York', 'rhode island': 'America/New_York',
  'sc': 'America/New_York', 'south carolina': 'America/New_York',
  'vt': 'America/New_York', 'vermont': 'America/New_York',
  'va': 'America/New_York', 'virginia': 'America/New_York',
  'wv': 'America/New_York', 'west virginia': 'America/New_York',
  'dc': 'America/New_York', 'washington dc': 'America/New_York', 'district of columbia': 'America/New_York',

  // Central Time
  'al': 'America/Chicago', 'alabama': 'America/Chicago',
  'ar': 'America/Chicago', 'arkansas': 'America/Chicago',
  'il': 'America/Chicago', 'illinois': 'America/Chicago',
  'ia': 'America/Chicago', 'iowa': 'America/Chicago',
  'ks': 'America/Chicago', 'kansas': 'America/Chicago',
  'la': 'America/Chicago', 'louisiana': 'America/Chicago',
  'mn': 'America/Chicago', 'minnesota': 'America/Chicago',
  'ms': 'America/Chicago', 'mississippi': 'America/Chicago',
  'mo': 'America/Chicago', 'missouri': 'America/Chicago',
  'ne': 'America/Chicago', 'nebraska': 'America/Chicago',
  'nd': 'America/Chicago', 'north dakota': 'America/Chicago',
  'ok': 'America/Chicago', 'oklahoma': 'America/Chicago',
  'sd': 'America/Chicago', 'south dakota': 'America/Chicago',
  'tn': 'America/Chicago', 'tennessee': 'America/Chicago',
  'tx': 'America/Chicago', 'texas': 'America/Chicago',
  'wi': 'America/Chicago', 'wisconsin': 'America/Chicago',

  // Mountain Time
  'az': 'America/Denver', 'arizona': 'America/Denver',
  'co': 'America/Denver', 'colorado': 'America/Denver',
  'id': 'America/Denver', 'idaho': 'America/Denver',
  'mt': 'America/Denver', 'montana': 'America/Denver',
  'nm': 'America/Denver', 'new mexico': 'America/Denver',
  'ut': 'America/Denver', 'utah': 'America/Denver',
  'wy': 'America/Denver', 'wyoming': 'America/Denver',

  // Pacific Time
  'ca': 'America/Los_Angeles', 'california': 'America/Los_Angeles',
  'nv': 'America/Los_Angeles', 'nevada': 'America/Los_Angeles',
  'or': 'America/Los_Angeles', 'oregon': 'America/Los_Angeles',
  'wa': 'America/Los_Angeles', 'washington': 'America/Los_Angeles',

  // Alaska & Hawaii
  'ak': 'America/Anchorage', 'alaska': 'America/Anchorage',
  'hi': 'Pacific/Honolulu', 'hawaii': 'Pacific/Honolulu',

  // Canadian Provinces
  'on': 'America/New_York', 'ontario': 'America/New_York',
  'qc': 'America/New_York', 'quebec': 'America/New_York',
  'ns': 'America/New_York', 'nova scotia': 'America/New_York',
  'nb': 'America/New_York', 'new brunswick': 'America/New_York',
  'pe': 'America/New_York', 'prince edward island': 'America/New_York',
  'nl': 'America/New_York', 'newfoundland': 'America/New_York',
  'mb': 'America/Chicago', 'manitoba': 'America/Chicago',
  'sk': 'America/Chicago', 'saskatchewan': 'America/Chicago',
  'ab': 'America/Denver', 'alberta': 'America/Denver',
  'bc': 'America/Los_Angeles', 'british columbia': 'America/Los_Angeles',
};

// ══════════════════════════════════════════════════════════════════════════════
// VENUE NAME MAP (known venues — acts as a fast first-hit cache)
// ══════════════════════════════════════════════════════════════════════════════

const VENUE_NAME_TIMEZONE_MAP: Record<string, string> = {
  // Eastern
  'madison square garden': 'America/New_York', 'msg': 'America/New_York',
  'barclays center': 'America/New_York', 'metlife stadium': 'America/New_York',
  'yankee stadium': 'America/New_York', 'citi field': 'America/New_York',
  'ubs arena': 'America/New_York', 'prudential center': 'America/New_York',
  'td garden': 'America/New_York', 'fenway park': 'America/New_York', 'gillette stadium': 'America/New_York',
  'wells fargo center': 'America/New_York', 'lincoln financial field': 'America/New_York', 'citizens bank park': 'America/New_York',
  'capital one arena': 'America/New_York', 'nationals park': 'America/New_York', 'fedex field': 'America/New_York',
  'state farm arena': 'America/New_York', 'mercedes benz stadium': 'America/New_York', 'truist park': 'America/New_York',
  'hard rock stadium': 'America/New_York', 'kaseya center': 'America/New_York', 'amerant bank arena': 'America/New_York',
  'amalie arena': 'America/New_York', 'benchmark international arena': 'America/New_York', 'raymond james stadium': 'America/New_York',
  'amway center': 'America/New_York', 'camping world stadium': 'America/New_York', 'hard rock live': 'America/New_York',
  'ppg paints arena': 'America/New_York', 'acrisure stadium': 'America/New_York', 'pnc park': 'America/New_York',
  'rocket mortgage fieldhouse': 'America/New_York', 'progressive field': 'America/New_York',
  'little caesars arena': 'America/New_York', 'ford field': 'America/New_York', 'comerica park': 'America/New_York',
  'gainbridge fieldhouse': 'America/New_York', 'lucas oil stadium': 'America/New_York',
  'spectrum center': 'America/New_York', 'bank of america stadium': 'America/New_York',
  'colonial life arena': 'America/New_York', 'cfg bank arena': 'America/New_York', 'boardwalk hall': 'America/New_York',
  'mohegan sun arena': 'America/New_York', 'ubs arena at belmont park': 'America/New_York',

  // Central
  'united center': 'America/Chicago', 'wintrust arena': 'America/Chicago', 'wrigley field': 'America/Chicago', 'soldier field': 'America/Chicago', 'guaranteed rate field': 'America/Chicago',
  'at&t stadium': 'America/Chicago', 'globe life field': 'America/Chicago', 'american airlines center': 'America/Chicago',
  'minute maid park': 'America/Chicago', 'toyota center': 'America/Chicago', 'nrg stadium': 'America/Chicago',
  'legacy arena at the bjcc': 'America/Chicago', 'legacy arena': 'America/Chicago', 'bjcc': 'America/Chicago',
  'bridgestone arena': 'America/Chicago', 'nissan stadium': 'America/Chicago', 'geodis park': 'America/Chicago',
  'caesars superdome': 'America/Chicago', 'smoothie king center': 'America/Chicago',
  'fiserv forum': 'America/Chicago', 'american family field': 'America/Chicago', 'lambeau field': 'America/Chicago',
  'target center': 'America/Chicago', 'us bank stadium': 'America/Chicago', 'target field': 'America/Chicago',
  'busch stadium': 'America/Chicago', 'enterprise center': 'America/Chicago', 'chaifetz arena': 'America/Chicago',
  'arrowhead stadium': 'America/Chicago', 'kauffman stadium': 'America/Chicago', 't-mobile center': 'America/Chicago',
  'paycom center': 'America/Chicago', 'frost bank center': 'America/Chicago', 'alamodome': 'America/Chicago',
  'moody center': 'America/Chicago', 'q2 stadium': 'America/Chicago',

  // Mountain
  'ball arena': 'America/Denver', 'empower field': 'America/Denver', 'coors field': 'America/Denver',
  'footprint center': 'America/Denver', 'chase field': 'America/Denver', 'state farm stadium': 'America/Denver',
  'desert diamond arena': 'America/Denver',
  'delta center': 'America/Denver', 'rio tinto stadium': 'America/Denver', 'smith ballpark': 'America/Denver',
  'isotopes park': 'America/Denver', 'pit arena': 'America/Denver',

  // Pacific
  'sofi stadium': 'America/Los_Angeles', 'crypto.com arena': 'America/Los_Angeles', 'dodger stadium': 'America/Los_Angeles',
  'the forum': 'America/Los_Angeles', 'intuit dome': 'America/Los_Angeles', 'bmo stadium': 'America/Los_Angeles',
  'honda center': 'America/Los_Angeles', 'angel stadium': 'America/Los_Angeles',
  'petco park': 'America/Los_Angeles', 'snapdragon stadium': 'America/Los_Angeles', 'pechanga arena': 'America/Los_Angeles',
  'oracle park': 'America/Los_Angeles', 'chase center': 'America/Los_Angeles', 'oakland arena': 'America/Los_Angeles',
  'sap center': 'America/Los_Angeles', 'paypal park': 'America/Los_Angeles', 'levi stadium': 'America/Los_Angeles',
  'golden 1 center': 'America/Los_Angeles',
  'lumen field': 'America/Los_Angeles', 'climate pledge arena': 'America/Los_Angeles', 't-mobile park': 'America/Los_Angeles',
  'moda center': 'America/Los_Angeles', 'providence park': 'America/Los_Angeles',
  't-mobile arena': 'America/Los_Angeles', 'allegiant stadium': 'America/Los_Angeles',
  'mgm grand garden arena': 'America/Los_Angeles', 'sphere': 'America/Los_Angeles',
  'michelob ultra arena': 'America/Los_Angeles',
  'dolby live': 'America/Los_Angeles', 'dolby live at park mgm': 'America/Los_Angeles',
  'ph live at planet hollywood': 'America/Los_Angeles', 'ph live': 'America/Los_Angeles',
  'the colosseum at caesars palace': 'America/Los_Angeles', 'colosseum at caesars': 'America/Los_Angeles',
  'the venetian theatre': 'America/Los_Angeles', 'venetian theatre': 'America/Los_Angeles',
  'encore theater': 'America/Los_Angeles', 'encore theater at wynn': 'America/Los_Angeles',
  'palazzo theatre': 'America/Los_Angeles', 'palazzo theatre at the venetian': 'America/Los_Angeles',
  'the cosmopolitan': 'America/Los_Angeles', 'cosmopolitan of las vegas': 'America/Los_Angeles',
  'penn & teller theater': 'America/Los_Angeles', 'penn and teller theater': 'America/Los_Angeles',
  'westgate las vegas': 'America/Los_Angeles', 'fontainebleau las vegas': 'America/Los_Angeles',
  'tahoe blue event center': 'America/Los_Angeles',
  'nugget casino': 'America/Los_Angeles', 'nugget event center': 'America/Los_Angeles',
  'grand sierra resort': 'America/Los_Angeles', 'reno events center': 'America/Los_Angeles',
  'kia forum': 'America/Los_Angeles',
  'greek theatre': 'America/Los_Angeles', 'hollywood bowl': 'America/Los_Angeles',
  'the wiltern': 'America/Los_Angeles', 'rose bowl': 'America/Los_Angeles',
  'the three clubs': 'America/Los_Angeles', 'three clubs': 'America/Los_Angeles',

  // Canadian venues
  'centre bell': 'America/New_York', 'bell centre': 'America/New_York',
  'canadian tire centre': 'America/New_York',
  'scotiabank arena': 'America/New_York', 'rogers centre': 'America/New_York',
  'bmo field': 'America/New_York',
  'bell center': 'America/New_York',
  'place bell': 'America/New_York',
  'videotron centre': 'America/New_York',
  'td place': 'America/New_York',
  'scotiabank centre': 'America/New_York',
  'canada life centre': 'America/Chicago',
  'saddledome': 'America/Denver', 'scotiabank saddledome': 'America/Denver',
  'rogers place': 'America/Denver',
  'rogers arena': 'America/Los_Angeles',
  'bc place': 'America/Los_Angeles',
};

// ══════════════════════════════════════════════════════════════════════════════
// FRAGMENT / KEYWORD MAP
// ══════════════════════════════════════════════════════════════════════════════

const FRAGMENT_TIMEZONE_MAP: Record<string, string> = {
  'carolina': 'America/New_York',
  'columbia': 'America/New_York',
  'jersey': 'America/New_York',
  'york': 'America/New_York',
  'hampshire': 'America/New_York',
  'england': 'America/New_York',
  'virginia': 'America/New_York',
  'dakota': 'America/Chicago',
  'mexico': 'America/Denver',
};

// ══════════════════════════════════════════════════════════════════════════════
// IN-MEMORY CACHE + RATE LIMITER
// ══════════════════════════════════════════════════════════════════════════════

// Process-level cache: venue (lowercase) → timezone | 'NONE'
const _memoryCache = new Map<string, string>();

// Rate limiter for Nominatim (max 1 req per 1.1s)
let _lastGeocodedAt = 0;
async function rateLimitedDelay(): Promise<void> {
  const elapsed = Date.now() - _lastGeocodedAt;
  if (elapsed < 1100) {
    await new Promise(r => setTimeout(r, 1100 - elapsed));
  }
  _lastGeocodedAt = Date.now();
}

// Re-verification config
const REVERIFY_AFTER_DAYS = 30;
const REVERIFY_CHANCE = 0.02; // 2% chance per lookup

// ══════════════════════════════════════════════════════════════════════════════
// STATIC DETECTION (synchronous — no DB, no API)
// ══════════════════════════════════════════════════════════════════════════════

/**
 * Auto-detect timezone from venue text using only static/in-memory data.
 * Fast, synchronous. Returns null if no match found.
 */
export function detectTimezoneFromVenue(venue: string): string | null {
  if (!venue || venue.trim().length === 0) return null;

  const cacheKey = venue.trim().toLowerCase();
  const cached = _memoryCache.get(cacheKey);
  if (cached) return cached === 'NONE' ? null : cached;

  const venueNorm = normalizeText(venue);

  const matchesTerm = (text: string, term: string): boolean => {
    if (term.length <= 3) {
      const regex = new RegExp(`\\b${term.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\b`);
      return regex.test(text);
    }
    return text.includes(term);
  };

  // Step 1: Known venue names
  for (const [venueName, tz] of Object.entries(VENUE_NAME_TIMEZONE_MAP)) {
    if (venueNorm.includes(venueName)) return tz;
  }

  // Step 2: City lookup via library
  const fullLookup = lookupCityTimezone(venueNorm);
  if (fullLookup) return fullLookup;

  const segments = venueNorm.split(/[,|–\-]+/).map(s => s.trim()).filter(Boolean);
  for (const segment of segments) {
    const segLookup = lookupCityTimezone(segment);
    if (segLookup) return segLookup;
  }

  // Step 2b: Individual words as city names
  const allWords = venueNorm.split(/\s+/).filter(w => w.length >= 3);
  for (const word of allWords) {
    const clean = word.replace(/[^a-z]/g, '');
    if (clean.length >= 3) {
      const wordLookup = lookupCityTimezone(clean);
      if (wordLookup) return wordLookup;
    }
  }

  // Step 2c: Multi-word combinations
  const rawWords = venueNorm.split(/\s+/);
  for (let i = 0; i < rawWords.length - 1; i++) {
    const twoWord = rawWords[i] + ' ' + rawWords[i + 1];
    const twoLookup = lookupCityTimezone(twoWord);
    if (twoLookup) return twoLookup;

    if (i < rawWords.length - 2) {
      const threeWord = twoWord + ' ' + rawWords[i + 2];
      const threeLookup = lookupCityTimezone(threeWord);
      if (threeLookup) return threeLookup;
    }
  }

  // Step 3: State/province codes
  for (const segment of segments) {
    const words = segment.split(/\s+/);
    for (const word of words) {
      const clean = word.replace(/[^a-z]/g, '');
      if (clean.length === 2 && STATE_TIMEZONE_MAP[clean]) return STATE_TIMEZONE_MAP[clean];
    }
    for (const [state, tz] of Object.entries(STATE_TIMEZONE_MAP)) {
      if (state.length > 2 && segment.includes(state)) return tz;
    }
  }

  for (const word of allWords) {
    const clean = word.replace(/[^a-z]/g, '');
    if (clean.length === 2 && STATE_TIMEZONE_MAP[clean]) return STATE_TIMEZONE_MAP[clean];
  }
  for (const [state, tz] of Object.entries(STATE_TIMEZONE_MAP)) {
    if (state.length > 2 && venueNorm.includes(state)) return tz;
  }

  // Step 4: Fragment keywords
  for (const [fragment, tz] of Object.entries(FRAGMENT_TIMEZONE_MAP)) {
    if (matchesTerm(venueNorm, fragment)) return tz;
  }

  return null;
}

// ══════════════════════════════════════════════════════════════════════════════
// ASYNC DETECTION — Full pipeline with DB cache + geocoding
// ══════════════════════════════════════════════════════════════════════════════

/**
 * Full async timezone detection pipeline:
 *   1. In-memory cache
 *   2. MongoDB VenueTimezone collection
 *   3. Static maps (venue names, cities, states, fragments)
 *   4. Geocoding (Nominatim → TimeAPI.io)
 *   5. Longitude estimation fallback
 *
 * Results are persisted to MongoDB so each venue is only geocoded once ever.
 * Stale entries (>30 days) have a 2% chance of background re-verification.
 */
export async function detectTimezoneFromVenueAsync(venue: string): Promise<string | null> {
  if (!venue || venue.trim().length === 0) return null;

  const cacheKey = venue.trim().toLowerCase();

  // ── Layer 1: In-memory cache ──
  const memCached = _memoryCache.get(cacheKey);
  if (memCached) return memCached === 'NONE' ? null : memCached;

  // ── Layer 2: MongoDB persistent cache ──
  try {
    const VenueTimezone = await getVenueTimezoneModel();
    const dbEntry = await VenueTimezone.findOne({ venue: cacheKey }).lean() as VenueTimezoneDoc | null;
    if (dbEntry && dbEntry.timezone) {
      const tz = dbEntry.timezone;
      _memoryCache.set(cacheKey, tz);

      // Random re-verification of stale entries (non-blocking)
      const age = Date.now() - new Date(dbEntry.lastVerifiedAt || dbEntry.createdAt || Date.now()).getTime();
      if (age > REVERIFY_AFTER_DAYS * 24 * 60 * 60 * 1000 && Math.random() < REVERIFY_CHANCE) {
        reverifyInBackground(venue, cacheKey, tz);
      }

      return tz;
    }
    // If DB has this venue marked as unresolvable (no timezone field), skip to static
    if (dbEntry && !dbEntry.timezone) {
      _memoryCache.set(cacheKey, 'NONE');
      return null;
    }
  } catch {
    // DB not available — continue with static + geocoding
  }

  // ── Layer 3: Static detection ──
  const staticResult = detectTimezoneFromVenue(venue);
  if (staticResult) {
    _memoryCache.set(cacheKey, staticResult);
    persistToDb(cacheKey, staticResult, 'static').catch(() => {});
    return staticResult;
  }

  // ── Layer 4: Geocoding (rate-limited) ──
  const searchQueries = [
    venue.trim(),
    `${venue.trim()} arena`,
    `${venue.trim()} venue`,
  ];
  const segments = venue.split(/[,|–\-]+/).map(s => s.trim()).filter(Boolean);
  if (segments.length > 1) searchQueries.push(...segments);

  for (const query of searchQueries) {
    const result = await geocodeAndResolveTimezone(query);
    if (result) {
      const tz = normalizeTimezone(result.timezone);
      _memoryCache.set(cacheKey, tz);
      persistToDb(cacheKey, tz, result.source, result.lat, result.lon, query).catch(() => {});
      console.log(`Timezone geocoded: "${venue}" → ${tz} (via "${query}")`);
      return tz;
    }
  }

  // All failed
  _memoryCache.set(cacheKey, 'NONE');
  console.warn(`Timezone auto-detect: Could not determine timezone from venue "${venue}" (all methods failed)`);
  return null;
}

/**
 * Bulk-resolve timezones for an array of venue names.
 * Efficient: checks DB in one query, only geocodes truly unknown venues.
 * Returns a Map<venue, timezone | null>.
 */
export async function resolveVenueTimezonesBulk(venues: string[]): Promise<Map<string, string | null>> {
  const result = new Map<string, string | null>();
  const toResolve: string[] = [];

  // Check memory cache first
  for (const venue of venues) {
    const key = venue.trim().toLowerCase();
    const cached = _memoryCache.get(key);
    if (cached) {
      result.set(venue, cached === 'NONE' ? null : cached);
    } else {
      toResolve.push(venue);
    }
  }

  if (toResolve.length === 0) return result;

  // Batch query MongoDB for all unknowns
  try {
    const VenueTimezone = await getVenueTimezoneModel();
    const keys = toResolve.map(v => v.trim().toLowerCase());
    const dbEntries = await VenueTimezone.find({ venue: { $in: keys } }).lean() as VenueTimezoneDoc[];
    const dbMap = new Map(dbEntries.map((e) => [e.venue, e]));

    const stillUnknown: string[] = [];

    for (const venue of toResolve) {
      const key = venue.trim().toLowerCase();
      const dbEntry = dbMap.get(key);
      if (dbEntry?.timezone) {
        _memoryCache.set(key, dbEntry.timezone);
        result.set(venue, dbEntry.timezone);

        // Random re-verification
        const age = Date.now() - new Date(dbEntry.lastVerifiedAt || dbEntry.createdAt || Date.now()).getTime();
        if (age > REVERIFY_AFTER_DAYS * 24 * 60 * 60 * 1000 && Math.random() < REVERIFY_CHANCE) {
          reverifyInBackground(venue, key, dbEntry.timezone);
        }
      } else {
        stillUnknown.push(venue);
      }
    }

    // Try static detection for remaining unknowns
    const needGeocoding: string[] = [];
    for (const venue of stillUnknown) {
      const key = venue.trim().toLowerCase();
      const staticTz = detectTimezoneFromVenue(venue);
      if (staticTz) {
        _memoryCache.set(key, staticTz);
        result.set(venue, staticTz);
        persistToDb(key, staticTz, 'static').catch(() => {});
      } else {
        needGeocoding.push(venue);
      }
    }

    // Geocode truly unknown venues (rate-limited, sequential)
    for (const venue of needGeocoding) {
      const tz = await detectTimezoneFromVenueAsync(venue);
      result.set(venue, tz);
    }
  } catch {
    // DB unavailable — fall back to individual resolution
    for (const venue of toResolve) {
      if (!result.has(venue)) {
        const tz = await detectTimezoneFromVenueAsync(venue);
        result.set(venue, tz);
      }
    }
  }

  return result;
}

// ══════════════════════════════════════════════════════════════════════════════
// GEOCODING: Nominatim → TimeAPI.io coordinate lookup
// ══════════════════════════════════════════════════════════════════════════════

interface VenueTimezoneDoc {
  venue: string;
  timezone: string;
  source?: string;
  lat?: number;
  lon?: number;
  geocodeQuery?: string;
  lastVerifiedAt?: Date;
  createdAt?: Date;
}

interface GeocodeResult {
  timezone: string;
  source: 'geocoded' | 'coords_fallback';
  lat: number;
  lon: number;
}

async function geocodeAndResolveTimezone(query: string): Promise<GeocodeResult | null> {
  try {
    await rateLimitedDelay();

    // Step 1: Geocode with Nominatim
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 8000);

    const encoded = encodeURIComponent(query);
    const res = await fetch(
      `https://nominatim.openstreetmap.org/search?q=${encoded}&format=json&limit=1&countrycodes=us,ca`,
      {
        signal: controller.signal,
        headers: { 'User-Agent': 'EventScraperPortal/1.0' },
      }
    );
    clearTimeout(timer);

    if (!res.ok) return null;

    const results = await res.json();
    if (!results || results.length === 0) return null;

    const lat = parseFloat(results[0].lat);
    const lon = parseFloat(results[0].lon);
    if (isNaN(lat) || isNaN(lon)) return null;

    // Step 2: Coordinates → timezone via TimeAPI.io
    const tzController = new AbortController();
    const tzTimer = setTimeout(() => tzController.abort(), 8000);

    const tzRes = await fetch(
      `https://timeapi.io/api/timezone/coordinate?latitude=${lat}&longitude=${lon}`,
      { signal: tzController.signal }
    );
    clearTimeout(tzTimer);

    if (tzRes.ok) {
      const tzData = await tzRes.json();
      if (tzData?.timeZone && typeof tzData.timeZone === 'string') {
        return { timezone: tzData.timeZone, source: 'geocoded', lat, lon };
      }
    }

    // Fallback: estimate from longitude
    const estimated = estimateUSTimezoneFromCoords(lat, lon);
    if (estimated) {
      return { timezone: estimated, source: 'coords_fallback', lat, lon };
    }
  } catch {
    // Network error — silently fail
  }

  return null;
}

function estimateUSTimezoneFromCoords(lat: number, lon: number): string | null {
  if (lat < 24 || lat > 72 || lon < -170 || lon > -50) return null;

  if (lon >= -67.5)  return 'America/New_York';
  if (lon >= -82.5)  return 'America/New_York';
  if (lon >= -97.5)  return 'America/Chicago';
  if (lon >= -112.5) return 'America/Denver';
  if (lon >= -125)   return 'America/Los_Angeles';
  if (lon >= -145)   return 'America/Anchorage';
  return 'Pacific/Honolulu';
}

// ══════════════════════════════════════════════════════════════════════════════
// DB PERSISTENCE + BACKGROUND RE-VERIFICATION
// ══════════════════════════════════════════════════════════════════════════════

async function persistToDb(
  venueKey: string, timezone: string, source: string,
  lat?: number, lon?: number, geocodeQuery?: string
): Promise<void> {
  try {
    const VenueTimezone = await getVenueTimezoneModel();
    await VenueTimezone.findOneAndUpdate(
      { venue: venueKey },
      {
        $set: {
          timezone,
          source,
          ...(lat != null && { lat }),
          ...(lon != null && { lon }),
          ...(geocodeQuery && { geocodeQuery }),
          lastVerifiedAt: new Date(),
        },
      },
      { upsert: true }
    );
  } catch {
    // DB write failed — not critical, memory cache still works
  }
}

function reverifyInBackground(venue: string, cacheKey: string, currentTz: string): void {
  // Fire-and-forget: re-geocode and update if different
  (async () => {
    try {
      const searchQueries = [venue.trim(), `${venue.trim()} arena`];
      for (const query of searchQueries) {
        const result = await geocodeAndResolveTimezone(query);
        if (result) {
          const newTz = normalizeTimezone(result.timezone);
          if (newTz !== currentTz) {
            console.log(`Timezone re-verify: "${venue}" changed ${currentTz} → ${newTz}`);
          }
          _memoryCache.set(cacheKey, newTz);
          await persistToDb(cacheKey, newTz, result.source, result.lat, result.lon, query);
          return;
        }
      }
      // Re-verification didn't find anything new — just update lastVerifiedAt
      const VenueTimezone = await getVenueTimezoneModel();
      await VenueTimezone.updateOne({ venue: cacheKey }, { $set: { lastVerifiedAt: new Date() } });
    } catch {
      // Background task — silently fail
    }
  })();
}

// ══════════════════════════════════════════════════════════════════════════════
// shouldStopEvent (sync + async)
// ══════════════════════════════════════════════════════════════════════════════

/**
 * @param fallbackTimezone - Used when the venue's timezone cannot be detected.
 *   If omitted, returns null for undetectable venues.
 */
export async function shouldStopEventAsync(
  eventDateTime: Date,
  venue: string,
  stopBeforeMinutes: number,
  fallbackTimezone?: string
): Promise<{ shouldStop: boolean; timezone: string; localNow: Date; cutoff: Date; usedFallback: boolean } | null> {
  const detected = await detectTimezoneFromVenueAsync(venue);
  const timezone = detected || fallbackTimezone;
  if (!timezone) return null;

  const nowInEventTz = getCurrentTimeInTimezone(timezone);
  const cutoffTime = new Date(nowInEventTz.getTime() + stopBeforeMinutes * 60 * 1000);

  return {
    shouldStop: eventDateTime.getTime() <= cutoffTime.getTime(),
    timezone,
    localNow: nowInEventTz,
    cutoff: cutoffTime,
    usedFallback: !detected,
  };
}

export function shouldStopEvent(
  eventDateTime: Date,
  venue: string,
  stopBeforeMinutes: number
): { shouldStop: boolean; timezone: string; localNow: Date; cutoff: Date } | null {
  const timezone = detectTimezoneFromVenue(venue);
  if (!timezone) return null;

  const nowInEventTz = getCurrentTimeInTimezone(timezone);
  const cutoffTime = new Date(nowInEventTz.getTime() + stopBeforeMinutes * 60 * 1000);

  return {
    shouldStop: eventDateTime.getTime() <= cutoffTime.getTime(),
    timezone,
    localNow: nowInEventTz,
    cutoff: cutoffTime,
  };
}

// ══════════════════════════════════════════════════════════════════════════════
// TIME UTILITIES
// ══════════════════════════════════════════════════════════════════════════════

export function getCurrentTimeInTimezone(timezone: string): Date {
  const now = getAccurateNow();
  const formatter = new Intl.DateTimeFormat('en-US', {
    timeZone: timezone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    hour12: false,
  });

  const parts = formatter.formatToParts(now);
  const get = (type: string) => parts.find(p => p.type === type)?.value || '0';

  const year = parseInt(get('year'));
  const month = parseInt(get('month')) - 1;
  const day = parseInt(get('day'));
  const hour = parseInt(get('hour')) === 24 ? 0 : parseInt(get('hour'));
  const minute = parseInt(get('minute'));
  const second = parseInt(get('second'));

  return new Date(Date.UTC(year, month, day, hour, minute, second));
}

export function getTimezoneAbbr(timezone: string): string {
  const tz = US_TIMEZONES.find(t => t.value === timezone);
  if (tz) return tz.abbr;
  try {
    const now = getAccurateNow();
    const short = new Intl.DateTimeFormat('en-US', { timeZone: timezone, timeZoneName: 'short' })
      .formatToParts(now)
      .find(p => p.type === 'timeZoneName')?.value;
    return short || timezone.split('/').pop()?.replace(/_/g, ' ') || timezone;
  } catch {
    return timezone.split('/').pop()?.replace(/_/g, ' ') || timezone;
  }
}

export function getTimezoneLabel(timezone: string): string {
  const tz = US_TIMEZONES.find(t => t.value === timezone);
  if (tz) return tz.label;
  try {
    const now = getAccurateNow();
    const long = new Intl.DateTimeFormat('en-US', { timeZone: timezone, timeZoneName: 'long' })
      .formatToParts(now)
      .find(p => p.type === 'timeZoneName')?.value;
    return long || timezone.replace(/_/g, ' ');
  } catch {
    return timezone.replace(/_/g, ' ');
  }
}

export function formatCurrentTimeInTimezone(timezone: string): string {
  const now = getAccurateNow();
  return now.toLocaleString('en-US', {
    timeZone: timezone,
    hour: '2-digit',
    minute: '2-digit',
    hour12: true,
    month: 'short',
    day: 'numeric',
  });
}
