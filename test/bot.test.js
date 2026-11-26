'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { createServer } = require('node:http');
const { createApp } = require('../server');
const { loadAddresses, findCandidates, splitStreet, parseLine } = require('../address');
const { extractData } = require('../ai');

const addresses = loadAddresses();
const env = {
  BASE_URL: 'https://bot.example.test', TELEGRAM_BOT_TOKEN: 'fake-test-token', TELEGRAM_CHAT_ID: 'fake-chat',
  TELEGRAM_THREAD_ALL: '10', TELEGRAM_THREAD_WORKERS: '20', OPENAI_API_KEY: 'fake-key', SMSAPI_TOKEN: 'fake-key',
  FORWARD_TO: '+48000000001', CONSULTANT_PHONE: '+48000000002', EXCLUDED_NUMBERS: '+48000000003',
};
function fakeHttp(options = {}) {
  const calls = [];
  return { calls, async post(url, body, config) {
    calls.push({ url, body, config });
    if (url === 'https://api.openai.com/v1/chat/completions') {
      if (options.aiError) throw Object.assign(new Error('not exposed'), { code: 'TEST_AI_ERROR' });
      if (options.aiGate) await options.aiGate;
      const input = JSON.parse(body.messages[1].content);
      const literal = splitStreet(input.street || '');
      const data = options.data || { city: input.city || '', street: literal?.street || '', number: literal?.number || '',
        flat: literal?.flat || '', problem: input.language === 'en' ? 'Woda cieknie z rury.' : input.problem || '' };
      return { data: { choices: [{ finish_reason: 'stop', message: { content: JSON.stringify(data) } }] } };
    }
    if (url === 'https://api.smsapi.pl/sms.do') {
      if (options.smsError) throw new Error('fake sms unavailable');
      return { data: { ok: true } };
    }
    if (url === 'https://api.telegram.org/botfake-test-token/sendMessage') return { data: { ok: true } };
    throw new Error(`UNEXPECTED SERVICE: ${url}`);
  } };
}
async function fixture(t, options = {}) {
  const http = fakeHttp(options);
  const app = createApp({ env, http, addresses: options.addresses || addresses, logger: { error() {} } });
  const server = createServer(app);
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(async () => { await app.locals.waitForIdle(); await new Promise(resolve => server.close(resolve)); });
  const origin = `http://127.0.0.1:${server.address().port}`;
  async function post(route, fields = {}, sid = 'CA-test') {
    const r = await fetch(origin + route, { method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ CallSid: sid, From: '+48000000009', ...fields }) });
    assert.ok(r.ok, `${route}: ${r.status}`);
    return r.text();
  }
  return { app, http, post, origin, telegram: () => http.calls.filter(c => c.url.includes('api.telegram.org')) };
}
async function collect(f, { sid = 'CA-test', language = '2', city = 'Chorzów', street = 'Stabika 9/13', problem = 'Water is leaking from a pipe.', phone = '+48000000009' } = {}) {
  await f.post('/voice', { From: phone }, sid);
  await f.post('/voice/language', { Digits: language }, sid);
  await f.post('/voice/menu', { Digits: '1' }, sid);
  await f.post('/voice/awaria', {}, sid);
  await f.post('/voice/krok2', { SpeechResult: city }, sid);
  await f.post('/voice/krok3', { SpeechResult: street }, sid);
  await f.post('/voice/krok4', { SpeechResult: problem }, sid);
  return f.post('/voice/przetworz', {}, sid);
}
function assertLanguage(xml, language) {
  const tags = [...xml.matchAll(/<(Say|Gather)\b[^>]*>/g)].map(m => m[0]);
  assert.ok(tags.length);
  for (const tag of tags) if (tag.startsWith('<Say') || tag.includes('input="speech"')) assert.ok(tag.includes(`language="${language}"`), tag);
}

test('language menu uses DTMF, exactly the requested two languages and empty-result callback', async t => {
  const f = await fixture(t), xml = await f.post('/voice');
  assert.match(xml, /input="dtmf"/); assert.match(xml, /numDigits="1"/);
  assert.match(xml, /actionOnEmptyResult="true"/); assert.match(xml, /finishOnKey=""/);
  assert.match(xml, /Aby rozmawiać po polsku, naciśnij 1\./); assert.match(xml, /For English, press 2\./);
  assert.doesNotMatch(xml, /uk-UA|ukrai/);
});
for (const [digit, language] of [['1', 'pl-PL'], ['2', 'en-US']]) test(`selection ${digit} sets ${language}`, async t => {
  const f = await fixture(t); await f.post('/voice');
  assertLanguage(await f.post('/voice/language', { Digits: digit }), language);
  assertLanguage(await f.post('/voice/awaria'), language);
});
for (const digits of [['9', '8'], ['', ''], ['*', '#'], ['9', ''], ['', '9']]) test(`invalid/empty choices ${JSON.stringify(digits)} repeat once then Polish`, async t => {
  const f = await fixture(t); await f.post('/voice');
  assert.match(await f.post('/voice/language', { Digits: digits[0] }), /For English, press 2/);
  const xml = await f.post('/voice/language', { Digits: digits[1] });
  assertLanguage(xml, 'pl-PL'); assert.doesNotMatch(xml, /For English/);
});
test('valid English choice on second attempt and later menus retain language', async t => {
  const f = await fixture(t); await f.post('/voice'); await f.post('/voice/language', { Digits: '7' });
  assertLanguage(await f.post('/voice/language', { Digits: '2' }), 'en-US');
  assertLanguage(await f.post('/voice'), 'en-US');
  assertLanguage(await f.post('/voice/menu', { Digits: '' }), 'en-US');
  assertLanguage(await f.post('/voice/language', { Digits: '1' }), 'en-US');
});
for (const digit of ['1', '2']) test(`entire call speaks/recognizes chosen language ${digit}, preserving caller and apartment`, async t => {
  const f = await fixture(t), lang = digit === '1' ? 'pl-PL' : 'en-US';
  await f.post('/voice'); assertLanguage(await f.post('/voice/language', { Digits: digit }), lang);
  assertLanguage(await f.post('/voice/awaria'), lang);
  assertLanguage(await f.post('/voice/krok2', { SpeechResult: 'Chorzów' }), lang);
  assertLanguage(await f.post('/voice/krok3', { SpeechResult: 'Stabika 9/13' }), lang);
  assertLanguage(await f.post('/voice/krok4', { SpeechResult: digit === '1' ? 'Woda cieknie z rury.' : 'Water is leaking from a pipe.' }), lang);
  const confirm = await f.post('/voice/przetworz'); assertLanguage(confirm, lang);
  assert.match(confirm, /Stabika/); assert.match(confirm, digit === '1' ? /mieszkanie 13/ : /apartment 13/);
  assert.equal(f.telegram().length, 0);
  assertLanguage(await f.post('/voice/potwierdz', { Digits: '1' }), lang);
  await f.app.locals.waitForIdle();
  const all = f.telegram().find(c => c.body.message_thread_id === 10).body.text;
  assert.match(all, /Nowe zgłoszenie \(tel\):/); assert.match(all, /Firma: SM BARBARA/);
  assert.match(all, /Telefon: \+48000000009/); assert.match(all, /Adres: Chorzów, ul\. Księdza Antoniego Stabika 9\/13/);
  assert.match(all, /Awaria: Woda cieknie z rury\./); assert.match(all, /Obsługiwany: TAK/);
  assert.equal(f.telegram().length, 2);
});
test('parallel Polish and English calls do not share language, address or phone', async t => {
  const f = await fixture(t);
  await Promise.all([collect(f, { sid: 'CA-pl', language: '1', phone: '+48000000004', street: 'Stabika 9', problem: 'Brak prądu.' }), collect(f, { sid: 'CA-en', language: '2', street: 'Stabika 9/13' })]);
  assertLanguage(await f.post('/voice/krok3', {}, 'CA-pl'), 'pl-PL');
  assertLanguage(await f.post('/voice/krok3', {}, 'CA-en'), 'en-US');
  assert.equal(f.app.locals.sessions.get('CA-pl').parsed.data.flat, '');
  assert.equal(f.app.locals.sessions.get('CA-en').parsed.data.flat, '13');
  assert.equal(f.app.locals.sessions.get('CA-pl').callerPhone, '+48000000004');
  assert.equal(f.app.locals.sessions.get('CA-en').callerPhone, '+48000000009');
  await Promise.all([f.post('/voice/potwierdz', { Digits: '1', From: '+48000000004' }, 'CA-pl'), f.post('/voice/potwierdz', { Digits: '1' }, 'CA-en')]);
  await f.app.locals.waitForIdle();
  assert.equal(f.telegram().filter(c => c.body.message_thread_id === 10).length, 2);
});
test('address parser separates building/flat and preserves numbered street names', () => {
  for (const [input, street, building, flat] of [
    ['Stabika 9/13', 'Stabika', '9', '13'], ['Stabika 9', 'Stabika', '9', ''],
    ['ul. 11 Listopada 64/5', '11 Listopada', '64', '5'], ['Testowa 4a/19', 'Testowa', '4a', '19'],
    ['Testowa 139a przez 13', 'Testowa', '139a', '13'], ['Testowa 139a 13', 'Testowa', '139a', '13'],
    ['Stabika 9 flat 13', 'Stabika', '9', '13'],
  ]) assert.deepEqual(splitStreet(input), { street, number: building, flat });
  assert.equal(splitStreet('Stabika 139a13'), null);
  assert.equal(parseLine('Ruda Śląska ul. Testowa 9', 'TEST').city, 'Ruda Śląska');
});
test('real address lists support full/short names, Polish letters, inflection and typo Sabika', () => {
  for (const [city, street] of [['Chorzów', 'Stabika'], ['Chorzow', 'Księdza Antoniego Stabika'], ['Chorzowie', 'Stabika'], ['Chorzów', 'Sabika']]) {
    const hits = findCandidates({ city, street, number: '9' }, addresses);
    assert.equal(hits.length, 1, JSON.stringify(hits)); assert.equal(hits[0].company, 'SM BARBARA');
  }
  assert.equal(findCandidates({ city: 'Chorzów', street: 'Stabika', number: '9999' }, addresses).length, 0);
});
test('typo is offered for explicit English confirmation, never assigned beforehand', async t => {
  const f = await fixture(t), xml = await collect(f, { street: 'Sabika 9/13' });
  assert.match(xml, /similar address/); assert.match(xml, /Stabika/); assertLanguage(xml, 'en-US');
  assert.equal(f.telegram().length, 0); assert.equal(f.app.locals.sessions.get('CA-test').parsed.confirmed, false);
  await f.post('/voice/potwierdz', { Digits: '1' }); await f.app.locals.waitForIdle();
  assert.match(f.telegram()[0].body.text, /Firma: SM BARBARA/);
});
test('multiple candidates are queried one at a time, and only the selected company is assigned', async t => {
  const f = await fixture(t, { addresses: [
    { city: 'Chorzów', street: 'Stabika', number: '9', company: 'A' },
    { city: 'Chorzów', street: 'Slabika', number: '9', company: 'B' },
  ] });
  assert.match(await collect(f, { street: 'Sabika 9/13' }), /Several addresses/);
  assert.match(await f.post('/voice/potwierdz', { Digits: '2' }), /Slabika/);
  assert.equal(f.telegram().length, 0);
  await f.post('/voice/potwierdz', { Digits: '1' }); await f.app.locals.waitForIdle();
  assert.match(f.telegram()[0].body.text, /Firma: B/);
});
for (const end of ['3', 'empty', 'hangup']) test(`unconfirmed address retained without company (${end})`, async t => {
  const f = await fixture(t); await collect(f, { street: 'Sabika 9/13' });
  if (end === 'empty') { await f.post('/voice/potwierdz'); await f.post('/voice/potwierdz'); }
  else if (end === 'hangup') await f.post('/voice/status', { CallStatus: 'completed' });
  else await f.post('/voice/potwierdz', { Digits: end });
  await f.app.locals.waitForIdle();
  assert.equal(f.telegram().length, 1); const text = f.telegram()[0].body.text;
  assert.match(text, /Firma: NIEZNANA/); assert.match(text, /Obsługiwany: NIEUSTALONE/);
  assert.match(text, /Sabika 9\/13/); assert.match(text, /Niepewność:/);
});
test('correction retains English and caller phone; second failure saves uncertain report', async t => {
  const f = await fixture(t); await collect(f);
  assertLanguage(await f.post('/voice/potwierdz', { Digits: '2' }), 'en-US');
  assertLanguage(await f.post('/voice/awaria'), 'en-US');
  assert.equal(f.app.locals.sessions.get('CA-test').callerPhone, '+48000000009');
  await f.post('/voice/krok2', { SpeechResult: 'Chorzów' });
  await f.post('/voice/krok3', { SpeechResult: 'Stabika 9/13' });
  await f.post('/voice/krok4', { SpeechResult: 'Water is leaking from a pipe.' });
  await f.post('/voice/przetworz'); await f.post('/voice/potwierdz', { Digits: '2' });
  await f.app.locals.waitForIdle(); assert.match(f.telegram()[0].body.text, /Obsługiwany: NIEUSTALONE/);
});
test('speech silence repeats the same question without erasing city or changing language', async t => {
  const f = await fixture(t); await f.post('/voice/language', { Digits: '2' });
  await f.post('/voice/krok2', { SpeechResult: 'Chorzów' });
  const xml = await f.post('/voice/krok3'); assert.match(xml, /street, building number/); assertLanguage(xml, 'en-US');
  assert.equal(f.app.locals.sessions.get('CA-test').city, 'Chorzów');
});
test('same physical address in different companies stays uncertain even after confirmation', async t => {
  const f = await fixture(t, { addresses: ['A', 'B'].map(company => ({ city: 'Chorzów', street: 'Stabika', number: '9', company })) });
  await collect(f); await f.post('/voice/potwierdz', { Digits: '1' }); await f.app.locals.waitForIdle();
  assert.equal(f.telegram().length, 1); assert.match(f.telegram()[0].body.text, /sprzeczne przypisanie firm/);
  assert.match(f.telegram()[0].body.text, /Firma: NIEZNANA/);
});
test('unknown address remains unserved and notifications preserve the provided description', async t => {
  const f = await fixture(t); await collect(f, { language: '1', street: 'Nieznana 9999', problem: 'Brak prądu.' });
  assert.match(await f.post('/voice/potwierdz', { Digits: '1' }), /nie znajduje się w obszarze/);
  await f.app.locals.waitForIdle(); assert.equal(f.telegram().length, 1);
  assert.match(f.telegram()[0].body.text, /Obsługiwany: NIE\n/); assert.match(f.telegram()[0].body.text, /Awaria: Brak prądu\./);
});
test('duplicate confirmations and status callbacks do not send duplicate reports', async t => {
  const f = await fixture(t); await collect(f);
  await Promise.all([f.post('/voice/potwierdz', { Digits: '1' }), f.post('/voice/potwierdz', { Digits: '1' })]);
  await f.post('/voice/status', { CallStatus: 'completed' }); await f.app.locals.waitForIdle(); assert.equal(f.telegram().length, 2);
});
test('AI failure retains raw report with uncertainty, English prompts and no guessed company', async t => {
  const f = await fixture(t, { aiError: true }); assertLanguage(await collect(f), 'en-US');
  await f.post('/voice/potwierdz', { Digits: '1' }); await f.app.locals.waitForIdle();
  assert.equal(f.telegram().length, 1); assert.match(f.telegram()[0].body.text, /błąd odczytu lub tłumaczenia AI/);
  assert.match(f.telegram()[0].body.text, /Water is leaking from a pipe/); assert.match(f.telegram()[0].body.text, /Firma: NIEZNANA/);
});
test('AI request uses existing model/API with strict schema, validates refusal and preserves literal address', async () => {
  const http = fakeHttp({ data: { city: 'Made up', street: 'Translated street', number: '913', flat: '99', problem: 'Woda cieknie.' } });
  const data = await extractData(http, env, { source: 'phone', city: 'Chorzów', street: 'Sabika 9/13', problem: 'Water is leaking.', language: 'en' });
  assert.deepEqual(data, { city: 'Chorzów', street: 'Sabika', number: '9', flat: '13', problem: 'Woda cieknie.' });
  assert.equal(http.calls[0].body.model, 'gpt-4o-mini');
  assert.equal(http.calls[0].body.response_format.json_schema.strict, true);
  const noFlat = await extractData(http, env, { source: 'phone', city: 'Chorzów', street: 'Stabika 9', problem: '', language: 'en' });
  assert.equal(noFlat.flat, ''); assert.equal(noFlat.problem, '');
  for (const response of [
    { finish_reason: 'stop', message: { refusal: 'refused' } },
    { finish_reason: 'length', message: { content: '{}' } },
    { finish_reason: 'stop', message: { content: '{"city": 42}' } },
  ]) await assert.rejects(extractData({ post: async () => ({ data: { choices: [response] } }) }, env, {}));
});
test('excluded callers still forward and consultant busy callback works in English', async t => {
  const f = await fixture(t), xml = await f.post('/voice', { From: '+48000000003' });
  assert.match(xml, /<Dial>\+48000000001<\/Dial>/); assert.doesNotMatch(xml, /Gather/);
  await f.post('/voice/language', { Digits: '2' }, 'CA-consultant');
  assertLanguage(await f.post('/voice/menu', { Digits: '2' }, 'CA-consultant'), 'en-US');
  const busy = await f.post('/voice/po_polaczeniu', { DialCallStatus: 'busy' }, 'CA-consultant');
  assertLanguage(busy, 'en-US'); assert.match(busy, /voice\/awaria/);
  assert.match(await f.post('/voice/po_polaczeniu', { DialCallStatus: 'completed' }, 'CA-consultant'), /Hangup/);
  assert.equal(f.http.calls.length, 0);
});
test('SMS regression: Telegram topics, Polish fields, caller phone and SMSAPI acknowledgement', async t => {
  const f = await fixture(t, { data: { city: 'Chorzów', street: 'Stabika', number: '9', flat: '13', problem: 'Brak prądu.' } });
  assert.equal(await f.post('/sms', { Body: 'Chorzów Stabika 9/13, brak prądu.' }), '<Response></Response>');
  await f.app.locals.waitForIdle(); assert.equal(f.telegram().length, 2);
  assert.match(f.telegram()[0].body.text, /Nowe zgłoszenie \(SMS\)/); assert.match(f.telegram()[0].body.text, /Obsługiwany: TAK/);
  assert.equal(f.http.calls.find(c => c.url.includes('smsapi')).body.get('to'), '48000000009');
});
test('fuzzy SMS is retained for manual verification without assigning a company', async t => {
  const f = await fixture(t, { data: { city: 'Chorzów', street: 'Sabika', number: '9', flat: '13', problem: 'Brak prądu.' } });
  await f.post('/sms', { Body: 'Chorzów Sabika 9/13, brak prądu.' }); await f.app.locals.waitForIdle();
  assert.equal(f.telegram().length, 1); assert.match(f.telegram()[0].body.text, /Obsługiwany: NIEUSTALONE/);
});
test('SMSAPI failure does not stop Telegram delivery', async t => {
  const f = await fixture(t, { smsError: true }); await collect(f);
  await f.post('/voice/potwierdz', { Digits: '1' }); await f.app.locals.waitForIdle(); assert.equal(f.telegram().length, 2);
});
test('health endpoint returns success without contacting external services', async t => {
  const f = await fixture(t), r = await fetch(f.origin + '/health'); assert.deepEqual(await r.json(), { ok: true }); assert.equal(f.http.calls.length, 0);
});

test('hangup during AI processing still saves report exactly once without guessing company', async t => {
  let release;
  const gate = new Promise(resolve => { release = resolve; });
  const f = await fixture(t, { aiGate: gate });
  await f.post('/voice/language', { Digits: '2' });
  await f.post('/voice/krok2', { SpeechResult: 'Chorzów' });
  await f.post('/voice/krok3', { SpeechResult: 'Sabika 9/13' });
  await f.post('/voice/krok4', { SpeechResult: 'Water is leaking.' });
  const response = f.post('/voice/przetworz');
  while (!f.http.calls.some(c => c.url.includes('openai.com'))) await new Promise(resolve => setImmediate(resolve));
  await f.post('/voice/status', { CallStatus: 'completed' }); release();
  assert.match(await response, /Hangup/); await f.app.locals.waitForIdle();
  assert.equal(f.telegram().length, 1); assert.match(f.telegram()[0].body.text, /adres niepotwierdzony/);
});
test('hangup during address correction retains the original unconfirmed report', async t => {
  const f = await fixture(t); await collect(f); await f.post('/voice/potwierdz', { Digits: '2' });
  await f.post('/voice/status', { CallStatus: 'completed' }); await f.app.locals.waitForIdle();
  assert.equal(f.telegram().length, 1); assert.match(f.telegram()[0].body.text, /Telefon: \+48000000009/);
  assert.match(f.telegram()[0].body.text, /Obsługiwany: NIEUSTALONE/);
});
test('partial report is retained when caller hangs up during collection', async t => {
  const f = await fixture(t); await f.post('/voice/language', { Digits: '2' });
  await f.post('/voice/krok2', { SpeechResult: 'Chorzów' });
  await f.post('/voice/status', { CallStatus: 'completed' }); await f.app.locals.waitForIdle();
  assert.equal(f.telegram().length, 1); assert.match(f.telegram()[0].body.text, /niepełny adres/);
});
test('short/full street aliases in different companies never bypass ownership conflict', async t => {
  const f = await fixture(t, { addresses: [
    { city: 'Chorzów', street: 'Stabika', number: '9', company: 'A' },
    { city: 'Chorzów', street: 'Księdza Antoniego Stabika', number: '9', company: 'B' },
  ] });
  await collect(f); await f.post('/voice/potwierdz', { Digits: '1' }); await f.app.locals.waitForIdle();
  assert.equal(f.telegram().length, 1); assert.match(f.telegram()[0].body.text, /Firma: NIEZNANA/);
});
test('AI-corrected SMS street cannot assign company without confirmation', async t => {
  const f = await fixture(t, { data: { city: 'Chorzów', street: 'Stabika', number: '9', flat: '13', problem: 'Brak prądu.' } });
  await f.post('/sms', { Body: 'Chorzów Sabika 9/13, brak prądu.' }); await f.app.locals.waitForIdle();
  assert.equal(f.telegram().length, 1); assert.match(f.telegram()[0].body.text, /Firma: NIEZNANA/);
});
test('long reports are split into valid Telegram messages without truncating the original', async t => {
  const f = await fixture(t); const problem = 'Bardzo długi opis. '.repeat(400);
  await collect(f, { language: '1', problem });
  await f.post('/voice/potwierdz', { Digits: '3' }); await f.app.locals.waitForIdle();
  const parts = f.telegram().map(c => c.body.text);
  assert.ok(parts.length > 1); assert.ok(parts.every(text => Array.from(text).length <= 4000));
  assert.ok(parts.join('').includes(problem.trim()));
});
test('inflected Polish streets and city prepositions remain matchable and require confirmation', () => {
  const hits = findCandidates({ city: 'w Chorzowie', street: 'przy ulicy Gołębiej', number: '9' }, [
    { city: 'Chorzów', street: 'Gołębia', number: '9', company: 'TEST' },
  ]);
  assert.equal(hits.length, 1); assert.equal(hits[0].approximate, true);
});
