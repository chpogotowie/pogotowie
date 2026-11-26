'use strict';
const fs = require('node:fs');
const path = require('node:path');
const COMPANY_FILES = [
  ['ADM 1 WSPOLNOTY', 'adm-1-wspolnoty.txt'], ['SDSM', 'sdsm.txt'],
  ['SM BARBARA', 'sm-barbara.txt'], ['PRYWATNY BUDENEK', 'prywatny-budenek.txt'],
];
const normalize = value => String(value || '').toLowerCase().replace(/ł/g, 'l')
  .normalize('NFD').replace(/[\u0300-\u036f]/g, '').replace(/[.,]/g, ' ').replace(/\s+/g, ' ').trim();
const cleanStreet = value => String(value || '').trim()
  .replace(/^(?:ul\.?|ulica|al\.?|aleja|aleje|pl\.?|plac|os\.?|osiedle|street)\s+/i, '').trim();
const number = value => String(value || '').toLowerCase().replace(/\s+/g, '').replace(/\.$/, '');
const titles = new Set('dr doktora doktor ks ksiedza ksiadz sw swietego swietej gen generala general prof profesora profesor im imienia kard kardynala bp biskupa pralata mjr majora plk pulkownika kpt kapitana por porucznika inz inzyniera'.split(' '));
const tokens = value => normalize(cleanStreet(value)).split(' ').filter(t => t && !titles.has(t));

// Only the final number is the building: 11 in "11 Listopada 64/5" is street text.
function splitStreet(value) {
  const match = String(value || '').trim().match(/^(.*?)\s+(\d+[a-z]?)(?:\s*(?:\/|przez|over|slash|m\.?|mieszkanie|lokal|apartment|apt\.?|flat|unit)\s*(\d+[a-z]?)|\s+(\d+[a-z]?))?\s*[.!]?$/iu);
  if (!match) return null;
  return { street: cleanStreet(match[1]), number: number(match[2]), flat: number(match[3] || match[4]) };
}
function parseLine(line, company) {
  const raw = line.trim();
  const parts = raw.match(/^(.+?)\s+(?:ul\.?|al\.?|pl\.?|os\.?)\s+(.+)$/iu)
    || raw.match(/^(Ruda Śląska|\S+)\s+(.+)$/iu);
  if (!parts) return null;
  const street = splitStreet(parts[2]);
  if (!street || !street.street || street.flat) return null;
  return { city: parts[1], street: street.street, number: street.number, company, raw };
}
function loadAddresses(directory = path.join(__dirname, 'adresy')) {
  // Missing lists are a startup failure, not an empty service area.
  return COMPANY_FILES.flatMap(([company, file]) => fs.readFileSync(path.join(directory, file), 'utf8')
    .split(/\r?\n/).map(line => parseLine(line, company)).filter(Boolean));
}
function distance(a, b) {
  let row = Array.from({ length: b.length + 1 }, (_, i) => i);
  for (let i = 1; i <= a.length; i++) {
    const next = [i];
    for (let j = 1; j <= b.length; j++) next[j] = Math.min(next[j - 1] + 1, row[j] + 1, row[j - 1] + (a[i - 1] !== b[j - 1]));
    row = next;
  }
  return row[b.length];
}
function tokenMatches(a, b, fuzzy) {
  if (a === b) return true;
  if (!fuzzy || /\d/.test(a + b) || Math.min(a.length, b.length) < 4) return false;
  const stem = word => {
    const ending = ['iego', 'iemu', 'ymi', 'imi', 'ego', 'emu', 'ach', 'ami', 'om', 'ym', 'im', 'ej', 'ie', 'a', 'e', 'i', 'y', 'u', 'o']
      .find(suffix => word.endsWith(suffix) && word.length - suffix.length >= 4);
    return ending ? word.slice(0, -ending.length) : word;
  };
  if (stem(a) === stem(b)) return true;
  return distance(a, b) <= (Math.min(a.length, b.length) >= 8 ? 2 : 1);
}
function suffixMatch(a, b, fuzzy) {
  if (!a.length || a.length > b.length) return false;
  return a.every((t, i) => tokenMatches(t, b[b.length - a.length + i], fuzzy));
}
function findCandidates(data, addresses) {
  if (!data.city || !data.street || !data.number) return [];
  const city = normalize(data.city).replace(/^(?:w|we|in)\s+/, '');
  const street = tokens(data.street.replace(/^(?:na|przy|on)\s+(?:ulicy\s+)?/i, ''));
  const hits = addresses.filter(a => number(a.number) === number(data.number)
    && (tokenMatches(city, normalize(a.city), true) || city === normalize(a.city).replace(/ow$/, 'owie').replace(/ice$/, 'icach'))
    && (suffixMatch(street, tokens(a.street), true) || suffixMatch(tokens(a.street), street, true)));
  const unique = [...new Map(hits.map(a => [`${normalize(a.city)}|${normalize(a.street)}|${a.number}|${a.company}`, a])).values()];
  // Fold a short/full alias only if its expansion is unique, within one company.
  return unique.filter(a => {
    const expansions = unique.filter(b => a !== b && a.company === b.company && normalize(a.city) === normalize(b.city)
      && tokens(a.street).length < tokens(b.street).length && suffixMatch(tokens(a.street), tokens(b.street), false));
    return expansions.length !== 1;
  }).map(a => ({ ...a, approximate: city !== normalize(a.city) || !suffixMatch(street, tokens(a.street), false) }));
}
function formatAddress(data) {
  return `${data.city || 'BRAK'}, ul. ${cleanStreet(data.street) || 'BRAK'} ${data.number || 'BRAK'}${data.flat ? `/${data.flat}` : ''}`;
}
function sameAddress(a, b) {
  return normalize(a.city) === normalize(b.city) && number(a.number) === number(b.number)
    && (suffixMatch(tokens(a.street), tokens(b.street), false) || suffixMatch(tokens(b.street), tokens(a.street), false));
}
module.exports = { loadAddresses, findCandidates, formatAddress, splitStreet, normalize, cleanStreet, number, parseLine, sameAddress };
