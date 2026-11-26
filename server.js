'use strict';
require('dotenv').config();
const express = require('express');
const { VoiceResponse } = require('twilio').twiml;
const axios = require('axios');
const { loadAddresses, findCandidates, formatAddress, normalize, sameAddress } = require('./address');
const { extractData, fallbackData } = require('./ai');

const LANG = { pl: { language: 'pl-PL', voice: 'Polly.Ewa' }, en: { language: 'en-US', voice: 'Polly.Joanna' } };
const TEXT = {
  menu: ['Pogotowie awaryjne. Aby zgłosić awarię, naciśnij 1. Jeżeli jesteś ze służb bezpieczeństwa publicznego, naciśnij 2.', 'Emergency maintenance. To report a fault, press 1. If you are calling from public safety services, press 2.'],
  invalid: ['Nieprawidłowy wybór lub brak odpowiedzi. Spróbuj ponownie.', 'Invalid selection or no response. Please try again.'],
  city: ['Proszę podać miasto.', 'Please say the city.'],
  street: ['Proszę podać ulicę wraz z numerem budynku i mieszkania.', 'Please say the street, building number and apartment number.'],
  problem: ['Proszę opisać awarię.', 'Please describe the fault.'],
  unheard: ['Nie usłyszałem odpowiedzi. Spróbuj ponownie.', 'I did not hear an answer. Please try again.'],
  wait: ['Dziękujemy. Chwilę proszę, sprawdzam zgłoszenie.', 'Thank you. Please wait while I check your report.'],
  consultant: ['Łączę z konsultantem.', 'Connecting you to a consultant.'],
  unavailable: ['Konsultant jest niedostępny. Możesz zgłosić awarię automatycznie.', 'The consultant is unavailable. You can report the fault automatically.'],
  retry: ['Dobrze, podajmy adres jeszcze raz.', 'Let us enter the address again.'],
  uncertain: ['Zapisaliśmy zgłoszenie z informacją, że adres wymaga weryfikacji.', 'Your report has been recorded. The address needs verification.'],
  outside: ['Niestety, podany adres nie znajduje się w obszarze naszej obsługi.', 'Unfortunately, the address is outside our service area.'],
};

function createApp({ env = process.env, http = axios, addresses = loadAddresses(), logger = console } = {}) {
  const app = express();
  app.use(express.urlencoded({ extended: false })); app.use(express.json());
  const base = (env.BASE_URL || 'https://pogotowie-production.up.railway.app').replace(/\/$/, '');
  const sessions = new Map(), pending = new Set();
  const excluded = (env.EXCLUDED_NUMBERS || '').split(',').map(s => s.trim()).filter(Boolean);
  const consultant = env.CONSULTANT_PHONE || env.FORWARD_TO;
  const say = (xml, s, text) => xml.say(LANG[s.language || 'pl'], text);
  const tr = (s, key) => TEXT[key][s.language === 'en' ? 1 : 0];
  const redirect = (xml, route) => xml.redirect({ method: 'POST' }, `${base}${route}`);
  const reply = (res, xml) => res.type('text/xml').send(xml.toString());
  const gather = (xml, route, options = {}) => xml.gather({
    input: 'dtmf', numDigits: 1, finishOnKey: '', timeout: 8, actionOnEmptyResult: true,
    action: `${base}${route}`, method: 'POST', ...options,
  });
  const session = req => {
    const sid = req.body.CallSid;
    if (!sessions.has(sid)) sessions.set(sid, { callerPhone: req.body.From || '', language: null, languageAttempts: 0 });
    const s = sessions.get(sid); s.updatedAt = Date.now(); return s;
  };
  const track = promise => {
    pending.add(promise); promise.finally(() => pending.delete(promise)).catch(() => {}); return promise;
  };
  const safeLog = (service, err) => logger.error(`${service}: ${err.code || err.response?.status || 'FAILED'}`);
  const arrival = () => new Date(Date.now() + (Number(env.DOJAZD_MINUT) || 60) * 60000)
    .toLocaleTimeString('pl-PL', { timeZone: 'Europe/Warsaw', hour: '2-digit', minute: '2-digit', hour12: false });

  async function telegram(text, thread) {
    const payload = { chat_id: env.TELEGRAM_CHAT_ID, text };
    if (thread) payload.message_thread_id = Number(thread);
    // Telegram accepts up to 4096 characters; retain long original reports in parts.
    const chars = Array.from(text);
    for (let i = 0; i < chars.length; i += 4000) {
      const result = await http.post(`https://api.telegram.org/bot${env.TELEGRAM_BOT_TOKEN}/sendMessage`,
        { ...payload, text: chars.slice(i, i + 4000).join('') }, { timeout: 10000 });
      if (!result.data?.ok) throw new Error('TELEGRAM_REJECTED');
    }
  }
  async function sms(phone, text) {
    if (!phone) return;
    await http.post('https://api.smsapi.pl/sms.do', new URLSearchParams({
      to: phone.replace(/^\+/, ''), message: text, format: 'json', encoding: 'utf-8',
    }), { headers: { Authorization: `Bearer ${env.SMSAPI_TOKEN}`, 'Content-Type': 'application/x-www-form-urlencoded' }, timeout: 10000 });
  }
  function report(s, source) {
    const p = s.parsed;
    const uncertain = !p.confirmed || p.issues.length > 0 || p.companyConflict;
    const firma = p.confirmed && !uncertain ? p.candidate?.company : null;
    const served = uncertain ? 'NIEUSTALONE' : firma ? 'TAK' : 'NIE';
    const data = p.confirmed && p.candidate ? { ...p.data, ...p.candidate } : p.data;
    const adres = formatAddress(data);
    const text = `Nowe zgłoszenie (${source}):\nFirma: ${firma || 'NIEZNANA'}\nTelefon: ${s.callerPhone}\nAdres: ${adres}\nAwaria: ${p.data.problem || 'BRAK'}\nObsługiwany: ${served}`
      + (uncertain ? `\nNiepewność: ${[...p.issues, ...(p.companyConflict ? ['sprzeczne przypisanie firm w bazie'] : []), ...(!p.confirmed ? ['adres niepotwierdzony'] : [])].join('; ')}` : '')
      + (source === 'SMS' ? `\nOryginalny SMS: ${p.original.text}`
        : `\nOryginalne miasto: ${p.original.city}\nOryginalna ulica i numery: ${p.original.street}\nOryginalny opis awarii: ${p.original.problem}`);
    return { text, firma, served, adres };
  }
  async function notify(s, source = 'tel') {
    // Set synchronously: webhook retries and hang-up callbacks must not duplicate reports.
    if (s.notified || !s.parsed) return;
    s.notified = true;
    const r = report(s, source);
    const jobs = [telegram(r.text, env.TELEGRAM_THREAD_ALL)];
    if (r.served === 'TAK' && env.TELEGRAM_THREAD_WORKERS !== env.TELEGRAM_THREAD_ALL)
      jobs.push(telegram(r.text, env.TELEGRAM_THREAD_WORKERS));
    const english = s.language === 'en';
    const message = r.served === 'TAK'
      ? (english ? `Thank you for your report.\nAddress: ${r.adres}\nCompany: ${r.firma}\nEstimated arrival by ${arrival()}.` : `Dziękujemy za zgłoszenie.\nAdres: ${r.adres}\nFirma: ${r.firma}\nPrzewidywany dojazd do godziny ${arrival()}.`)
      : r.served === 'NIE'
        ? (english ? `Unfortunately, we do not service this address:\n${r.adres}\nPlease contact us again if the address is incorrect.` : `Przepraszamy, nie obsługujemy tego adresu:\n${r.adres}\nJeżeli adres jest nieprawidłowy, prosimy o ponowny kontakt.`)
        : (english ? `Your report has been recorded. The address needs verification:\n${r.adres}` : `Zgłoszenie zapisano. Adres wymaga weryfikacji:\n${r.adres}`);
    jobs.push(sms(s.callerPhone, message));
    const results = await Promise.allSettled(jobs);
    results.forEach((r, i) => { if (r.status === 'rejected') safeLog(i === jobs.length - 1 ? 'SMS' : 'Telegram', r.reason); });
    s.notificationFailed = results.some(r => r.status === 'rejected');
  }
  function languageMenu(xml) {
    const g = gather(xml, '/voice/language');
    g.say(LANG.pl, 'Aby rozmawiać po polsku, naciśnij 1.'); g.say(LANG.en, 'For English, press 2.');
  }
  function serviceMenu(xml, s) { say(gather(xml, '/voice/menu'), s, tr(s, 'menu')); }
  function question(xml, s, key, action) {
    const hints = key === 'city' ? [...new Set(addresses.map(a => a.city))]
      : key === 'street' ? [...new Set(addresses.filter(a => normalize(a.city) === normalize(s.city)).map(a => a.street))] : [];
    say(gather(xml, action, { input: 'speech', language: LANG[s.language || 'pl'].language, speechTimeout: 2, timeout: 10,
      ...(hints.length ? { hints: hints.filter(h => h.length <= 100).slice(0, 500).join(',') } : {}) }), s, tr(s, key));
  }
  function confirmation(xml, s) {
    const p = s.parsed, candidate = p.candidates[p.candidateIndex || 0]; p.candidate = candidate;
    const data = candidate ? { ...p.data, ...candidate } : p.data;
    const address = s.language === 'en'
      ? `${data.city || 'unknown city'}, ${data.street || 'unknown street'}, building ${data.number || 'unknown'}${data.flat ? `, apartment ${data.flat}` : ''}`
      : `${data.city || 'brak miasta'}, ulica ${data.street || 'brak ulicy'}, numer ${data.number || 'brak'}${data.flat ? `, mieszkanie ${data.flat}` : ''}`;
    const multiple = p.candidates.length > 1;
    const prompt = s.language === 'en'
      ? `${multiple ? 'Several addresses match. ' : candidate?.approximate ? 'I found a similar address. ' : ''}Is the address ${address}? Press 1 to confirm, 2 for ${multiple ? 'the next address or to enter it again' : 'correction'}, or 3 to save the report with an uncertain address.`
      : `${multiple ? 'Pasuje kilka adresów. ' : candidate?.approximate ? 'Znalazłem podobny adres. ' : ''}Czy adres to ${address}? Naciśnij 1, aby potwierdzić, 2, aby ${multiple ? 'sprawdzić kolejny adres lub podać go ponownie' : 'poprawić adres'}, lub 3, aby zapisać zgłoszenie z niepewnym adresem.`;
    say(gather(xml, '/voice/potwierdz'), s, prompt);
  }
  function prepare(data, original, issues = []) {
    return { data, original, issues: [...issues, ...(['city', 'street', 'number'].some(k => !data[k]) ? ['niepełny adres'] : []), ...(!data.problem ? ['brak opisu awarii'] : [])],
      candidates: findCandidates(data, addresses), candidateIndex: 0, confirmed: false };
  }
  function finish(xml, s) {
    const r = report(s, 'tel');
    if (r.served === 'TAK') say(xml, s, s.language === 'en' ? `Thank you for your report. Estimated arrival by ${arrival()}.` : `Dziękujemy za zgłoszenie. Przewidywany dojazd do godziny ${arrival()}.`);
    else say(xml, s, tr(s, r.served === 'NIE' ? 'outside' : 'uncertain'));
    xml.hangup(); track(notify(s));
  }
  app.get('/health', (req, res) => res.json({ ok: true }));
  app.use('/voice', (req, res, next) => { if (!req.body.CallSid) return res.status(400).send('CallSid required'); next(); });
  app.post('/voice', (req, res) => {
    const xml = new VoiceResponse();
    if (excluded.includes(req.body.From || '')) { if (env.FORWARD_TO) xml.dial(env.FORWARD_TO); else xml.hangup(); }
    else { const s = session(req); if (s.language) serviceMenu(xml, s); else languageMenu(xml); }
    reply(res, xml);
  });
  app.post('/voice/language', (req, res) => {
    const s = session(req), xml = new VoiceResponse();
    if (!s.language) {
      if (req.body.Digits === '1') s.language = 'pl';
      else if (req.body.Digits === '2') s.language = 'en';
      else if (++s.languageAttempts >= 2) s.language = 'pl';
    }
    if (s.language) serviceMenu(xml, s); else languageMenu(xml);
    reply(res, xml);
  });
  app.post('/voice/menu', (req, res) => {
    const s = session(req), xml = new VoiceResponse();
    if (req.body.Digits === '1') redirect(xml, '/voice/awaria');
    else if (req.body.Digits === '2' && consultant) {
      say(xml, s, tr(s, 'consultant'));
      xml.dial({ action: `${base}/voice/po_polaczeniu`, method: 'POST', timeout: 30 }).number(consultant);
    } else { say(xml, s, tr(s, 'invalid')); serviceMenu(xml, s); }
    reply(res, xml);
  });
  app.post('/voice/po_polaczeniu', (req, res) => {
    const s = session(req), xml = new VoiceResponse();
    if (req.body.DialCallStatus === 'completed') xml.hangup();
    else { say(xml, s, tr(s, 'unavailable')); redirect(xml, '/voice/awaria'); }
    reply(res, xml);
  });
  app.post('/voice/awaria', (req, res) => {
    const s = session(req), xml = new VoiceResponse(); question(xml, s, 'city', '/voice/krok2'); reply(res, xml);
  });
  // Empty speech repeats the same question without overwriting previous fields.
  for (const [route, field, current, next, action] of [
    ['/voice/krok2', 'city', 'city', 'street', '/voice/krok3'],
    ['/voice/krok3', 'street', 'street', 'problem', '/voice/krok4'],
    ['/voice/krok4', 'problem', 'problem', null, null],
  ]) app.post(route, (req, res) => {
    const s = session(req), xml = new VoiceResponse(), value = (req.body.SpeechResult || '').trim();
    if (!value) { say(xml, s, tr(s, 'unheard')); question(xml, s, current, route); }
    else { s[field] = value; if (next) question(xml, s, next, action); else { say(xml, s, tr(s, 'wait')); redirect(xml, '/voice/przetworz'); } }
    reply(res, xml);
  });
  app.post('/voice/przetworz', async (req, res) => {
    const s = session(req), xml = new VoiceResponse();
    if (s.notified) { xml.hangup(); return reply(res, xml); }
    if (!s.parsed) {
      const original = { source: 'phone', language: s.language || 'pl', city: s.city || '', street: s.street || '', problem: s.problem || '' };
      // Share the in-flight request if Twilio retries while AI is processing.
      s.processing ||= (async () => {
        try { s.parsed = prepare(await extractData(http, env, original), original); }
        catch (err) { safeLog('AI', err); s.parsed = prepare(fallbackData(original), original, ['błąd odczytu lub tłumaczenia AI']); }
      })();
      await s.processing;
    }
    if (s.ended) { track(notify(s)); xml.hangup(); } else confirmation(xml, s);
    reply(res, xml);
  });
  app.post('/voice/potwierdz', (req, res) => {
    const s = session(req), xml = new VoiceResponse(), p = s.parsed;
    if (s.notified) xml.hangup();
    else if (!p) redirect(xml, '/voice/awaria');
    else if (req.body.Digits === '1') {
      p.confirmed = true;
      // Contradictory company ownership cannot be settled by an address keypress.
      if (p.candidate) p.companyConflict = p.candidates.some(a => a.company !== p.candidate.company
        && sameAddress(a, p.candidate));
      finish(xml, s);
    } else if (req.body.Digits === '2') {
      p.confirmationAttempts = 0;
      if (p.candidateIndex + 1 < p.candidates.length) { p.candidateIndex++; confirmation(xml, s); }
      else if ((s.addressRetries || 0) < 1) {
        s.addressRetries = (s.addressRetries || 0) + 1;
        // Retain rejected data until replacement input has been processed.
        s.previousParsed = p; delete s.parsed; delete s.processing;
        say(xml, s, tr(s, 'retry')); redirect(xml, '/voice/awaria');
      } else { p.issues.push('nie udało się potwierdzić adresu po ponownym podaniu'); finish(xml, s); }
    } else if (req.body.Digits === '3' || (p.confirmationAttempts = (p.confirmationAttempts || 0) + 1) >= 2) finish(xml, s);
    else { say(xml, s, tr(s, 'invalid')); confirmation(xml, s); }
    reply(res, xml);
  });
  app.post('/voice/status', (req, res) => {
    const s = sessions.get(req.body.CallSid);
    if (s && ['completed', 'canceled', 'failed', 'busy', 'no-answer'].includes(req.body.CallStatus)) {
      s.ended = true;
      if (!s.parsed && s.previousParsed && !s.processing) s.parsed = s.previousParsed;
      if (!s.parsed && !s.processing && (s.city || s.street || s.problem)) {
        const original = { source: 'phone', language: s.language || 'pl', city: s.city || '', street: s.street || '', problem: s.problem || '' };
        s.parsed = prepare(fallbackData(original), original, ['rozmowa przerwana przed odczytem i potwierdzeniem danych']);
      }
      if (s.parsed && !s.notified) track(notify(s));
    }
    res.sendStatus(204);
  });
  app.post('/sms', (req, res) => {
    res.type('text/xml').send('<Response></Response>');
    track((async () => {
      const original = { source: 'sms', text: req.body.Body || '' };
      const s = { callerPhone: req.body.From || '', language: 'pl' };
      try {
        s.parsed = prepare(await extractData(http, env, original), original);
        // SMS has no confirmation step. Only a unique literal match is trusted.
        const p = s.parsed;
        const literal = normalize(original.text);
        if (!literal.includes(normalize(p.data.city)) || !literal.includes(normalize(p.data.street)))
          p.issues.push('nazwy adresu odczytane przez AI nie występują dosłownie w SMS');
        if (p.data.number && !new RegExp(`(^|[^0-9a-z])${p.data.number}($|[^0-9a-z])`, 'i').test(literal))
          p.issues.push('numer budynku z SMS wymaga weryfikacji');
        if (p.candidates.length === 1 && !p.candidates[0].approximate && p.issues.length === 0) { p.candidate = p.candidates[0]; p.confirmed = true; }
        else if (!p.candidates.length && p.issues.length === 0) p.confirmed = true;
      } catch (err) {
        safeLog('AI SMS', err);
        s.parsed = prepare({ city: '', street: '', number: '', flat: '', problem: 'Nie udało się odczytać SMS; patrz oryginał.' }, original, ['błąd odczytu AI']);
      }
      await notify(s, 'SMS');
    })().catch(err => safeLog('SMS handler', err)));
  });
  app.locals.sessions = sessions;
  app.locals.pruneSessions = () => {
    for (const [sid, s] of sessions) if (s.updatedAt < Date.now() - 24 * 3600000) sessions.delete(sid);
  };
  app.locals.waitForIdle = async () => { while (pending.size) await Promise.allSettled([...pending]); };
  return app;
}
if (require.main === module) {
  if (process.argv[2] === 'test') console.log(JSON.stringify(findCandidates({ city: process.argv[3], street: process.argv[4], number: process.argv[5] }, loadAddresses()), null, 2));
  else {
    const app = createApp();
    setInterval(app.locals.pruneSessions, 3600000).unref();
    app.listen(process.env.PORT || 3000, () => console.log('Serwer uruchomiony'));
  }
}
module.exports = { createApp, LANG };
