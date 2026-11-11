'use strict';
// What a visitor from each country usually looks like: the main time zone, the usual browser
// language and a rough position (the largest city). Used so that the identity a site sees
// agrees with the country its connection arrives from. Country-level only: a large country
// gets the zone most of its people live in.

// CC: [name, time zone, language, latitude, longitude]
const COUNTRIES = {
  AE: ['United Arab Emirates', 'Asia/Dubai', 'ar-AE', 25.2, 55.27],
  AL: ['Albania', 'Europe/Tirane', 'sq-AL', 41.33, 19.82],
  AM: ['Armenia', 'Asia/Yerevan', 'hy-AM', 40.18, 44.51],
  AO: ['Angola', 'Africa/Luanda', 'pt-AO', -8.84, 13.23],
  AR: ['Argentina', 'America/Argentina/Buenos_Aires', 'es-AR', -34.6, -58.38],
  AT: ['Austria', 'Europe/Vienna', 'de-AT', 48.21, 16.37],
  AU: ['Australia', 'Australia/Sydney', 'en-AU', -33.87, 151.21],
  AZ: ['Azerbaijan', 'Asia/Baku', 'az-AZ', 40.41, 49.87],
  BA: ['Bosnia and Herzegovina', 'Europe/Sarajevo', 'bs-BA', 43.86, 18.41],
  BD: ['Bangladesh', 'Asia/Dhaka', 'bn-BD', 23.81, 90.41],
  BE: ['Belgium', 'Europe/Brussels', 'nl-BE', 50.85, 4.35],
  BG: ['Bulgaria', 'Europe/Sofia', 'bg-BG', 42.7, 23.32],
  BH: ['Bahrain', 'Asia/Bahrain', 'ar-BH', 26.23, 50.59],
  BO: ['Bolivia', 'America/La_Paz', 'es-BO', -16.5, -68.15],
  BR: ['Brazil', 'America/Sao_Paulo', 'pt-BR', -23.55, -46.63],
  BY: ['Belarus', 'Europe/Minsk', 'ru-BY', 53.9, 27.57],
  CA: ['Canada', 'America/Toronto', 'en-CA', 43.65, -79.38],
  CH: ['Switzerland', 'Europe/Zurich', 'de-CH', 47.38, 8.54],
  CL: ['Chile', 'America/Santiago', 'es-CL', -33.45, -70.67],
  CM: ['Cameroon', 'Africa/Douala', 'fr-CM', 4.05, 9.77],
  CN: ['China', 'Asia/Shanghai', 'zh-CN', 31.23, 121.47],
  CO: ['Colombia', 'America/Bogota', 'es-CO', 4.71, -74.07],
  CR: ['Costa Rica', 'America/Costa_Rica', 'es-CR', 9.93, -84.08],
  CY: ['Cyprus', 'Asia/Nicosia', 'el-CY', 35.17, 33.36],
  CZ: ['Czechia', 'Europe/Prague', 'cs-CZ', 50.08, 14.44],
  DE: ['Germany', 'Europe/Berlin', 'de-DE', 52.52, 13.4],
  DK: ['Denmark', 'Europe/Copenhagen', 'da-DK', 55.68, 12.57],
  DO: ['Dominican Republic', 'America/Santo_Domingo', 'es-DO', 18.49, -69.93],
  DZ: ['Algeria', 'Africa/Algiers', 'ar-DZ', 36.75, 3.06],
  EC: ['Ecuador', 'America/Guayaquil', 'es-EC', -2.17, -79.92],
  EE: ['Estonia', 'Europe/Tallinn', 'et-EE', 59.44, 24.75],
  EG: ['Egypt', 'Africa/Cairo', 'ar-EG', 30.04, 31.24],
  ES: ['Spain', 'Europe/Madrid', 'es-ES', 40.42, -3.7],
  ET: ['Ethiopia', 'Africa/Addis_Ababa', 'am-ET', 9.03, 38.74],
  FI: ['Finland', 'Europe/Helsinki', 'fi-FI', 60.17, 24.94],
  FR: ['France', 'Europe/Paris', 'fr-FR', 48.86, 2.35],
  GB: ['United Kingdom', 'Europe/London', 'en-GB', 51.51, -0.13],
  GE: ['Georgia', 'Asia/Tbilisi', 'ka-GE', 41.72, 44.79],
  GH: ['Ghana', 'Africa/Accra', 'en-GH', 5.6, -0.19],
  GR: ['Greece', 'Europe/Athens', 'el-GR', 37.98, 23.73],
  GT: ['Guatemala', 'America/Guatemala', 'es-GT', 14.63, -90.51],
  HK: ['Hong Kong', 'Asia/Hong_Kong', 'zh-HK', 22.32, 114.17],
  HN: ['Honduras', 'America/Tegucigalpa', 'es-HN', 14.07, -87.19],
  HR: ['Croatia', 'Europe/Zagreb', 'hr-HR', 45.81, 15.98],
  HU: ['Hungary', 'Europe/Budapest', 'hu-HU', 47.5, 19.04],
  ID: ['Indonesia', 'Asia/Jakarta', 'id-ID', -6.21, 106.85],
  IE: ['Ireland', 'Europe/Dublin', 'en-IE', 53.35, -6.26],
  IL: ['Israel', 'Asia/Jerusalem', 'he-IL', 32.09, 34.78],
  IN: ['India', 'Asia/Kolkata', 'en-IN', 19.08, 72.88],
  IQ: ['Iraq', 'Asia/Baghdad', 'ar-IQ', 33.31, 44.37],
  IR: ['Iran', 'Asia/Tehran', 'fa-IR', 35.69, 51.39],
  IS: ['Iceland', 'Atlantic/Reykjavik', 'is-IS', 64.15, -21.94],
  IT: ['Italy', 'Europe/Rome', 'it-IT', 41.9, 12.5],
  JO: ['Jordan', 'Asia/Amman', 'ar-JO', 31.95, 35.93],
  JP: ['Japan', 'Asia/Tokyo', 'ja-JP', 35.68, 139.69],
  KE: ['Kenya', 'Africa/Nairobi', 'en-KE', -1.29, 36.82],
  KG: ['Kyrgyzstan', 'Asia/Bishkek', 'ru-KG', 42.87, 74.59],
  KH: ['Cambodia', 'Asia/Phnom_Penh', 'km-KH', 11.56, 104.92],
  KR: ['South Korea', 'Asia/Seoul', 'ko-KR', 37.57, 126.98],
  KW: ['Kuwait', 'Asia/Kuwait', 'ar-KW', 29.38, 47.99],
  KZ: ['Kazakhstan', 'Asia/Almaty', 'ru-KZ', 43.24, 76.89],
  LA: ['Laos', 'Asia/Vientiane', 'lo-LA', 17.97, 102.63],
  LB: ['Lebanon', 'Asia/Beirut', 'ar-LB', 33.89, 35.5],
  LK: ['Sri Lanka', 'Asia/Colombo', 'si-LK', 6.93, 79.86],
  LT: ['Lithuania', 'Europe/Vilnius', 'lt-LT', 54.69, 25.28],
  LU: ['Luxembourg', 'Europe/Luxembourg', 'fr-LU', 49.61, 6.13],
  LV: ['Latvia', 'Europe/Riga', 'lv-LV', 56.95, 24.11],
  LY: ['Libya', 'Africa/Tripoli', 'ar-LY', 32.89, 13.19],
  MA: ['Morocco', 'Africa/Casablanca', 'ar-MA', 33.57, -7.59],
  MD: ['Moldova', 'Europe/Chisinau', 'ro-MD', 47.01, 28.86],
  ME: ['Montenegro', 'Europe/Podgorica', 'sr-ME', 42.44, 19.26],
  MK: ['North Macedonia', 'Europe/Skopje', 'mk-MK', 42.0, 21.43],
  MM: ['Myanmar', 'Asia/Yangon', 'my-MM', 16.87, 96.2],
  MN: ['Mongolia', 'Asia/Ulaanbaatar', 'mn-MN', 47.89, 106.91],
  MO: ['Macao', 'Asia/Macau', 'zh-MO', 22.2, 113.54],
  MT: ['Malta', 'Europe/Malta', 'en-MT', 35.9, 14.51],
  MX: ['Mexico', 'America/Mexico_City', 'es-MX', 19.43, -99.13],
  MY: ['Malaysia', 'Asia/Kuala_Lumpur', 'ms-MY', 3.14, 101.69],
  MZ: ['Mozambique', 'Africa/Maputo', 'pt-MZ', -25.97, 32.57],
  NG: ['Nigeria', 'Africa/Lagos', 'en-NG', 6.52, 3.38],
  NI: ['Nicaragua', 'America/Managua', 'es-NI', 12.11, -86.24],
  NL: ['Netherlands', 'Europe/Amsterdam', 'nl-NL', 52.37, 4.9],
  NO: ['Norway', 'Europe/Oslo', 'nb-NO', 59.91, 10.75],
  NP: ['Nepal', 'Asia/Kathmandu', 'ne-NP', 27.72, 85.32],
  NZ: ['New Zealand', 'Pacific/Auckland', 'en-NZ', -36.85, 174.76],
  OM: ['Oman', 'Asia/Muscat', 'ar-OM', 23.59, 58.41],
  PA: ['Panama', 'America/Panama', 'es-PA', 8.98, -79.52],
  PE: ['Peru', 'America/Lima', 'es-PE', -12.05, -77.04],
  PH: ['Philippines', 'Asia/Manila', 'en-PH', 14.6, 120.98],
  PK: ['Pakistan', 'Asia/Karachi', 'en-PK', 24.86, 67.0],
  PL: ['Poland', 'Europe/Warsaw', 'pl-PL', 52.23, 21.01],
  PR: ['Puerto Rico', 'America/Puerto_Rico', 'es-PR', 18.47, -66.11],
  PS: ['Palestine', 'Asia/Hebron', 'ar-PS', 31.9, 35.2],
  PT: ['Portugal', 'Europe/Lisbon', 'pt-PT', 38.72, -9.14],
  PY: ['Paraguay', 'America/Asuncion', 'es-PY', -25.26, -57.58],
  QA: ['Qatar', 'Asia/Qatar', 'ar-QA', 25.29, 51.53],
  RO: ['Romania', 'Europe/Bucharest', 'ro-RO', 44.43, 26.1],
  RS: ['Serbia', 'Europe/Belgrade', 'sr-RS', 44.79, 20.45],
  RU: ['Russia', 'Europe/Moscow', 'ru-RU', 55.76, 37.62],
  RW: ['Rwanda', 'Africa/Kigali', 'en-RW', -1.94, 30.06],
  SA: ['Saudi Arabia', 'Asia/Riyadh', 'ar-SA', 24.71, 46.68],
  SC: ['Seychelles', 'Indian/Mahe', 'en-SC', -4.62, 55.45],
  SE: ['Sweden', 'Europe/Stockholm', 'sv-SE', 59.33, 18.07],
  SG: ['Singapore', 'Asia/Singapore', 'en-SG', 1.35, 103.82],
  SI: ['Slovenia', 'Europe/Ljubljana', 'sl-SI', 46.06, 14.51],
  SK: ['Slovakia', 'Europe/Bratislava', 'sk-SK', 48.15, 17.11],
  SN: ['Senegal', 'Africa/Dakar', 'fr-SN', 14.72, -17.47],
  SV: ['El Salvador', 'America/El_Salvador', 'es-SV', 13.69, -89.22],
  SY: ['Syria', 'Asia/Damascus', 'ar-SY', 33.51, 36.28],
  TH: ['Thailand', 'Asia/Bangkok', 'th-TH', 13.76, 100.5],
  TN: ['Tunisia', 'Africa/Tunis', 'ar-TN', 36.81, 10.18],
  TR: ['Türkiye', 'Europe/Istanbul', 'tr-TR', 41.01, 28.98],
  TW: ['Taiwan', 'Asia/Taipei', 'zh-TW', 25.03, 121.57],
  TZ: ['Tanzania', 'Africa/Dar_es_Salaam', 'sw-TZ', -6.79, 39.21],
  UA: ['Ukraine', 'Europe/Kyiv', 'uk-UA', 50.45, 30.52],
  UG: ['Uganda', 'Africa/Kampala', 'en-UG', 0.35, 32.58],
  US: ['United States', 'America/New_York', 'en-US', 40.71, -74.01],
  UY: ['Uruguay', 'America/Montevideo', 'es-UY', -34.9, -56.16],
  UZ: ['Uzbekistan', 'Asia/Tashkent', 'uz-UZ', 41.3, 69.24],
  VE: ['Venezuela', 'America/Caracas', 'es-VE', 10.48, -66.9],
  VN: ['Vietnam', 'Asia/Ho_Chi_Minh', 'vi-VN', 10.82, 106.63],
  YE: ['Yemen', 'Asia/Aden', 'ar-YE', 15.37, 44.19],
  ZA: ['South Africa', 'Africa/Johannesburg', 'en-ZA', -26.2, 28.05],
  ZM: ['Zambia', 'Africa/Lusaka', 'en-ZM', -15.39, 28.32],
  ZW: ['Zimbabwe', 'Africa/Harare', 'en-ZW', -17.83, 31.05],
};

// Zones this build of Node does not know (an older tz database) fall back to an alias that it does.
const ALIAS = {
  'Europe/Kyiv': 'Europe/Kiev',
  'Asia/Yangon': 'Asia/Rangoon',
  'Asia/Ho_Chi_Minh': 'Asia/Saigon',
  'Asia/Kolkata': 'Asia/Calcutta',
};
const zoneOk = (tz) => {
  try {
    new Intl.DateTimeFormat('en-US', { timeZone: tz });
    return true;
  } catch {
    return false;
  }
};
const checked = new Map();
function zone(tz) {
  if (!checked.has(tz)) checked.set(tz, zoneOk(tz) ? tz : ALIAS[tz] && zoneOk(ALIAS[tz]) ? ALIAS[tz] : 'UTC');
  return checked.get(tz);
}

// Countries that span several time zones: Cloudflare's judge also names the data centre nearest
// the exit (an airport code), which is enough to tell the coasts apart.
const COLO_ZONE = {
  LAX: 'America/Los_Angeles',
  SJC: 'America/Los_Angeles',
  SFO: 'America/Los_Angeles',
  SEA: 'America/Los_Angeles',
  PDX: 'America/Los_Angeles',
  SAN: 'America/Los_Angeles',
  SMF: 'America/Los_Angeles',
  LAS: 'America/Los_Angeles',
  PHX: 'America/Phoenix',
  DEN: 'America/Denver',
  SLC: 'America/Denver',
  ABQ: 'America/Denver',
  ORD: 'America/Chicago',
  DFW: 'America/Chicago',
  IAH: 'America/Chicago',
  MSP: 'America/Chicago',
  MCI: 'America/Chicago',
  STL: 'America/Chicago',
  OMA: 'America/Chicago',
  BNA: 'America/Chicago',
  MEM: 'America/Chicago',
  SAT: 'America/Chicago',
  AUS: 'America/Chicago',
  HNL: 'Pacific/Honolulu',
  ANC: 'America/Anchorage',
  YVR: 'America/Vancouver',
  YYC: 'America/Edmonton',
  YWG: 'America/Winnipeg',
  YUL: 'America/Toronto',
  PER: 'Australia/Perth',
  ADL: 'Australia/Adelaide',
  BNE: 'Australia/Brisbane',
  MEL: 'Australia/Melbourne',
  SVX: 'Asia/Yekaterinburg',
  OVB: 'Asia/Novosibirsk',
  KJA: 'Asia/Krasnoyarsk',
  VVO: 'Asia/Vladivostok',
  MAO: 'America/Manaus',
  FOR: 'America/Fortaleza',
};
const COLO_CC = { US: 1, CA: 1, AU: 1, RU: 1, BR: 1 };
// The largest city of each of those zones, so that a position given out agrees with the clock.
const ZONE_SPOT = {
  'America/Los_Angeles': [34.05, -118.24],
  'America/Phoenix': [33.45, -112.07],
  'America/Denver': [39.74, -104.99],
  'America/Chicago': [41.88, -87.63],
  'Pacific/Honolulu': [21.31, -157.86],
  'America/Anchorage': [61.22, -149.9],
  'America/Vancouver': [49.28, -123.12],
  'America/Edmonton': [51.05, -114.07],
  'America/Winnipeg': [49.9, -97.14],
  'Australia/Perth': [-31.95, 115.86],
  'Australia/Adelaide': [-34.93, 138.6],
  'Australia/Brisbane': [-27.47, 153.03],
  'Australia/Melbourne': [-37.81, 144.96],
  'Asia/Yekaterinburg': [56.84, 60.6],
  'Asia/Novosibirsk': [55.03, 82.92],
  'Asia/Krasnoyarsk': [56.01, 92.87],
  'Asia/Vladivostok': [43.12, 131.89],
  'America/Manaus': [-3.12, -60.02],
  'America/Fortaleza': [-3.73, -38.52],
};

/** Accept-Language list a browser set up in that language would send. */
function languagesFor(tag) {
  const base = tag.split('-')[0];
  return base === 'en' ? (tag === 'en-US' ? ['en-US', 'en'] : [tag, 'en']) : [tag, base, 'en-US', 'en'];
}

/**
 * What goes with a country code (and, in countries with several time zones, the nearest data centre).
 * @returns {{cc, name, tz, languages: string[], lat, lon}|null}
 */
function place(cc, colo) {
  cc = String(cc || '').toUpperCase();
  const c = COUNTRIES[cc];
  if (!c) return null;
  const near = COLO_CC[cc] && COLO_ZONE[String(colo || '').toUpperCase()];
  const spot = (near && ZONE_SPOT[near]) || [c[3], c[4]];
  return { cc, name: c[0], tz: zone(near || c[1]), languages: languagesFor(c[2]), lat: spot[0], lon: spot[1] };
}

const countryName = (cc) => (COUNTRIES[String(cc || '').toUpperCase()] || [String(cc || '').toUpperCase()])[0];

module.exports = { COUNTRIES, place, countryName, languagesFor };
