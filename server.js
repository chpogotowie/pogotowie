require('dotenv').config();

const express = require('express');
const bodyParser = require('body-parser');
const { VoiceResponse } = require('twilio').twiml;
const axios = require('axios');
const fs = require('fs');
const path = require('path');

const BASE_URL = process.env.BASE_URL || 'https://pogotowie-production.up.railway.app';
const DOJAZD_MINUT = parseInt(process.env.DOJAZD_MINUT || '60');

const EXCLUDED_NUMBERS = (process.env.EXCLUDED_NUMBERS || '').split(',').map(n => n.trim()).filter(Boolean);
const FORWARD_TO = process.env.FORWARD_TO || '+48668550725';

// Numer konsultanta - łatwy do zmiany w Railway
const CONSULTANT_PHONE = process.env.CONSULTANT_PHONE || '+48668550725';
const twilioClient = require('twilio')(
    process.env.TWILIO_SID,
    process.env.TWILIO_AUTH_TOKEN
);

// ========== POWIADOMIENIA ==========

async function sendTelegram(message, threadId) {
    try {
        const payload = { chat_id: process.env.TELEGRAM_CHAT_ID, text: message };
        if (threadId) payload.message_thread_id = parseInt(threadId);
        const response = await axios.post(
            `https://api.telegram.org/bot${process.env.TELEGRAM_BOT_TOKEN}/sendMessage`,
            payload
        );
        console.log('Telegram wysłano | ok:', response.data.ok);
        return response.data;
    } catch (err) {
        console.error('Telegram błąd:', err.response?.data || err.message);
        throw err;
    }
}

async function sendSms(to, message) {
    const phone = to.replace(/^\+/, '');
    try {
        const response = await axios.post(
            'https://api.smsapi.pl/sms.do',
            new URLSearchParams({ to: phone, message, format: 'json', encoding: 'utf-8' }),
            {
                headers: {
                    'Authorization': `Bearer ${process.env.SMSAPI_TOKEN}`,
                    'Content-Type': 'application/x-www-form-urlencoded'
                }
            }
        );
        console.log('SMSAPI wysłano do:', phone, '| status:', response.data);
        return response.data;
    } catch (err) {
        console.error('SMSAPI błąd:', err.response?.data || err.message);
        throw err;
    }
}

// ========== DOPASOWANIE ADRESÓW (NOWA, MOCNIEJSZA WERSJA) ==========

const MULTI_WORD_CITIES = ['Ruda Śląska'];

const STREET_PREFIX_RE = /^(ul\.?|ulica|al\.?|aleja|aleje|pl\.?|plac|os\.?|osiedle|skwer|rondo)$/i;

const HONORIFIC_TOKENS = new Set([
    'dr', 'doktora', 'doktor',
    'ks', 'ksiedza', 'ksiadz',
    'sw', 'swietego', 'swietej', 'sw.',
    'gen', 'generala', 'general',
    'prof', 'profesora', 'profesor',
    'im', 'imienia',
    'kard', 'kardynala', 'kardynal',
    'bp', 'biskupa', 'biskup',
    'pralata', 'pralat',
    'mjr', 'majora',
    'plk', 'pulkownika',
    'kpt', 'kapitana',
    'por', 'porucznika',
    'inz', 'inzyniera'
]);

function stripDiacritics(s) {
    return (s || '')
        .toLowerCase()
        .replace(/ł/g, 'l')
        .replace(/Ł/g, 'l')
        .normalize('NFD')
        .replace(/[\u0300-\u036f]/g, '');
}

// Polski "stemmer" - obcinamy typowe końcówki przypadków/liczby mnogiej.
// Zostawiamy minimum 4 znaki rdzenia, żeby nie pomylić różnych słów.
function polishStem(word) {
    let w = stripDiacritics(word).replace(/[^a-z0-9]/g, '');
    if (!w) return '';
    // Cyfry: nie ruszamy
    if (/\d/.test(w)) return w;
    // Lista końcówek (od najdłuższych do najkrótszych)
    const endings = [
        'iego', 'iemu', 'iego', 'iej', 'imi', 'ymi',
        'ego', 'emu', 'ach', 'ami', 'om',
        'ym', 'im', 'ej', 'ie',
        'a', 'e', 'i', 'y', 'u', 'o'
    ];
    for (const e of endings) {
        if (w.endsWith(e) && w.length - e.length >= 4) {
            return w.slice(0, -e.length);
        }
    }
    return w;
}

function fuzzyTokenEqual(a, b) {
    if (!a || !b) return false;
    const sa = polishStem(a);
    const sb = polishStem(b);
    if (!sa || !sb) return false;
    if (sa === sb) return true;
    // Liczby muszą być identyczne
    if (/\d/.test(sa) || /\d/.test(sb)) return sa === sb;
    // Tolerancja prefiksu (na wypadek różnic typu "swiet" vs "swietoch")
    const minLen = Math.min(sa.length, sb.length);
    if (minLen < 4) return false;
    return sa.startsWith(sb) || sb.startsWith(sa);
}

function tokenizeSimple(text) {
    return (text || '')
        .replace(/[.,/\\-]/g, ' ')
        .split(/\s+/)
        .map(t => t.trim())
        .filter(Boolean);
}

// Parsowanie pojedynczej linii pliku adresów na strukturę {city, street, number}
function parseCandidateLine(line) {
    const raw = line.trim();
    if (!raw) return null;

    let cityRaw = null;
    let rest = raw;

    // Najpierw sprawdzamy miasta dwuwyrazowe (np. "Ruda Śląska")
    for (const c of MULTI_WORD_CITIES) {
        if (rest.toLowerCase().startsWith(c.toLowerCase() + ' ')) {
            cityRaw = c;
            rest = rest.slice(c.length).trim();
            break;
        }
    }

    if (!cityRaw) {
        // Pierwszy token to miasto
        const firstSpace = rest.indexOf(' ');
        if (firstSpace === -1) return null;
        cityRaw = rest.slice(0, firstSpace);
        rest = rest.slice(firstSpace + 1).trim();
    }

    const tokens = tokenizeSimple(rest);
    if (tokens.length < 2) return null;

    // Ostatni token = numer budynku
    const numberRaw = tokens[tokens.length - 1].toLowerCase();
    let middle = tokens.slice(0, -1);

    // Usuń przedrostki typu "ul.", "al." z początku
    while (middle.length && STREET_PREFIX_RE.test(middle[0])) {
        middle = middle.slice(1);
    }

    if (middle.length === 0) return null;

    const streetRaw = middle.join(' ');

    return {
        raw,
        city: cityRaw,
        cityStem: polishStem(cityRaw),
        cityStemTokens: tokenizeSimple(cityRaw).map(polishStem),
        street: streetRaw,
        streetStems: middle.map(polishStem).filter(Boolean),
        // Również wersja bez honoryfików/tytułów (dr, ks, sw, gen...)
        streetCoreStems: middle
            .filter(t => !HONORIFIC_TOKENS.has(stripDiacritics(t).replace(/\./g, '')))
            .map(polishStem)
            .filter(Boolean),
        number: numberRaw
    };
}

function loadAddressFile(file) {
    try {
        const lines = fs.readFileSync(file, 'utf-8').split('\n');
        const parsed = [];
        for (const line of lines) {
            const p = parseCandidateLine(line);
            if (p) parsed.push(p);
        }
        return parsed;
    } catch (e) {
        console.error(`Błąd wczytywania pliku ${file}:`, e.message);
        return [];
    }
}

const COMPANIES = [
    { name: 'MPGL',       candidates: loadAddressFile(path.join(__dirname, 'adresy/mpgl.txt')) },
    { name: 'SDSM',       candidates: loadAddressFile(path.join(__dirname, 'adresy/sdsm.txt')) },
    { name: 'SM BARBARA', candidates: loadAddressFile(path.join(__dirname, 'adresy/sm-barbara.txt')) }
];

console.log(`Załadowano adresów: MPGL=${COMPANIES[0].candidates.length}, SDSM=${COMPANIES[1].candidates.length}, Barbara=${COMPANIES[2].candidates.length}`);

function normalizeNumber(num) {
    return (num || '').toString().toLowerCase().replace(/\s+/g, '').replace(/\.$/, '');
}

function cityMatches(inputCity, candidate) {
    if (!inputCity) return false;
    const inputTokens = tokenizeSimple(inputCity).map(polishStem).filter(Boolean);
    if (inputTokens.length === 0) return false;

    // Każdy token miasta z wejścia musi mieć dopasowanie w mieście kandydata
    for (const t of inputTokens) {
        const ok = candidate.cityStemTokens.some(c => fuzzyTokenEqual(t, c));
        if (!ok) return false;
    }
    return true;
}

function streetMatches(inputStreet, candidate) {
    if (!inputStreet) return false;
    // Usuń przedrostki "ul.", "al.", itp.
    const cleaned = inputStreet
        .replace(/^(ul\.?|ulica|al\.?|aleja|aleje|pl\.?|plac|os\.?|osiedle)\s+/i, '')
        .trim();

    const inputTokens = tokenizeSimple(cleaned);
    if (inputTokens.length === 0) return false;

    const inputStems = inputTokens
        .filter(t => !HONORIFIC_TOKENS.has(stripDiacritics(t).replace(/\./g, '')))
        .map(polishStem)
        .filter(Boolean);

    if (inputStems.length === 0) return false;

    // Wszystkie istotne tokeny ulicy z wejścia muszą się znaleźć w kandydacie
    // (porównujemy z pełną listą rdzeni kandydata, nie tylko core, żeby honoryfiki też pasowały gdy są w wejściu)
    for (const t of inputStems) {
        const ok = candidate.streetStems.some(c => fuzzyTokenEqual(t, c));
        if (!ok) return false;
    }
    return true;
}

function numberMatches(inputNumber, candidate) {
    const a = normalizeNumber(inputNumber);
    const b = normalizeNumber(candidate.number);
    if (!a || !b) return false;
    return a === b;
}

function findFirma(city, street, number) {
    const inputNumberNorm = normalizeNumber(number);
    console.log(`SZUKAM: miasto="${city}" ulica="${street}" numer="${inputNumberNorm}"`);

    for (const { name, candidates } of COMPANIES) {
        const match = candidates.find(c =>
            numberMatches(number, c) &&
            cityMatches(city, c) &&
            streetMatches(street, c)
        );
        if (match) {
            console.log(`DOPASOWANIE ${name}: "${match.raw}"`);
            return name;
        }
    }
    console.log('BRAK DOPASOWANIA dla:', { city, street, number });
    return null;
}

function normalizujUlice(street) {
    const s = (street || '').toLowerCase();
    if (s.includes('mari') && (
        s.includes('dulc') ||
        s.includes('duz') ||
        s.includes('dulsi') ||
        s.includes('holc') ||
        s.includes('hofm') ||
        s.includes('hoffm') ||
        s.includes('man')
    )) {
        return 'Marii Dulcissimy Hoffmann';
    }
    return street;
}

function godzinaDojazdu() {
    const teraz = new Date();
    teraz.setMinutes(teraz.getMinutes() + DOJAZD_MINUT);
    return teraz.toLocaleTimeString('pl-PL', {
        timeZone: 'Europe/Warsaw',
        hour: '2-digit',
        minute: '2-digit',
        hour12: false
    });
}

// ========== TRYB TESTOWY Z LINII POLECEŃ ==========
// Użycie: node server.js test "Świętochłowice" "Witolda Pileckiego" "20"
if (process.argv[2] === 'test') {
    const result = findFirma(process.argv[3] || '', process.argv[4] || '', process.argv[5] || '');
    console.log('WYNIK:', result || 'BRAK');
    process.exit(0);
}

// ========== APLIKACJA EXPRESS ==========

const app = express();
app.use(bodyParser.urlencoded({ extended: false }));
app.use(bodyParser.json());

const sessions = new Map();


setInterval(() => {
    const teraz = Date.now();
    let usuniete = 0;
    for (const [sid, sesja] of sessions) {
        if (!sesja.utworzono) sesja.utworzono = teraz;
        if (teraz - sesja.utworzono > 10 * 60 * 1000) {
            sessions.delete(sid);
            usuniete++;
        }
    }
    if (usuniete > 0) console.log(`Wyczyszczono ${usuniete} starych sesji`);
}, 60 * 1000);

app.post('/voice', (req, res) => {
    const callSid = req.body.CallSid;
    const callerPhone = req.body.From || '';
    console.log(`[${callSid}] Otrzymano żądanie /voice`);

    if (EXCLUDED_NUMBERS.includes(callerPhone)) {
        const twiml = new VoiceResponse();
        twiml.dial(FORWARD_TO);
        res.type('text/xml');
        res.send(twiml.toString());
        return;
    }
    sessions.set(callSid, { callerPhone });

    const twiml = new VoiceResponse();
    const gather = twiml.gather({
        input: 'dtmf', numDigits: 1, timeout: 8,
        action: `${BASE_URL}/voice/menu`, method: 'POST'
    });
    gather.say({ language: 'pl-PL', voice: 'Polly.Ola-Neural' },
        'Pogotowie awaryjne. Aby zgłosić awarię, naciśnij 1. Jeżeli jesteś z Służb bezpieczeństwa publicznego, naciśnij 2.');
    // Nie ma redirect - gather obsłuży akcję

    res.type('text/xml');
    res.send(twiml.toString());
});

app.post('/voice/menu', (req, res) => {
    const callSid = req.body.CallSid;
    const digit = req.body.Digits || '';
    console.log(`[${callSid}] Menu wybór: "${digit}"`);
    console.log(`[${callSid}] Otrzymano żądanie /voice/menu`);

    const twiml = new VoiceResponse();

    if (digit === '1') {
        console.log(`[${callSid}] Wybrano opcję 1 - awaria`);
        console.log(`[${callSid}] Przekierowanie na: ${BASE_URL}/voice/awaria`);
        twiml.redirect(`${BASE_URL}/voice/awaria`);
    } else if (digit === '2') {
        console.log(`[${callSid}] Przekierowanie do konsultanta na numer: ${CONSULTANT_PHONE}`);
        console.log(`[${callSid}] CONSULTANT_PHONE wartość: ${CONSULTANT_PHONE}`);
        console.log(`[${callSid}] Twilio From: ${req.body.From}`);
        twiml.say({ language: 'pl-PL', voice: 'Polly.Ola-Neural' }, 'Łączę z konsultantem.');
        
        // Warm transfer - bezpośrednie przekierowanie na numer wirtualny
        const dial = twiml.dial({ 
            timeout: 60,
            callerId: req.body.From
        });
        dial.number(CONSULTANT_PHONE);

        res.type('text/xml');
        return res.send(twiml.toString()); 
    } else {
        twiml.say({ language: 'pl-PL', voice: 'Polly.Ola-Neural' }, 'Nieprawidłowy wybór.');
        twiml.redirect(`${BASE_URL}/voice`);
        res.type('text/xml');
        res.send(twiml.toString());
    }
});
app.post('/voice/awaria', (req, res) => {
    const callSid = req.body.CallSid;
    console.log(`[${callSid}] Otrzymano żądanie /voice/awaria`);
    
    const twiml = new VoiceResponse();
    const gather = twiml.gather({
        input: 'speech', language: 'pl-PL',
        speechTimeout: 'auto', timeout: 10,
        action: `${BASE_URL}/voice/krok2`, method: 'POST'
    });
    gather.say({ language: 'pl-PL', voice: 'Polly.Ola-Neural' }, 'Proszę podać miasto:');
    twiml.say({ language: 'pl-PL', voice: 'Polly.Ola-Neural' }, 'Nie usłyszałem miasta. Spróbuj ponownie.');
    twiml.redirect(`${BASE_URL}/voice/awaria`);

    console.log(`[${callSid}] Wysłano TwiML dla /voice/awaria`);
    res.type('text/xml');
    return res.send(twiml.toString());
});

app.post('/voice/krok2', (req, res) => {
    const callSid = req.body.CallSid;
    const city = req.body.SpeechResult || '';
    const session = sessions.get(callSid) || {};
    session.city = city;
    sessions.set(callSid, session);
    console.log(`[${callSid}] Miasto: "${city}"`);

    const twiml = new VoiceResponse();
    const gather = twiml.gather({
        input: 'speech', language: 'pl-PL',
        speechTimeout: 'auto', timeout: 10,
        action: `${BASE_URL}/voice/krok3`, method: 'POST'
    });
    gather.say({ language: 'pl-PL', voice: 'Polly.Ola-Neural' }, 'Proszę podać ulicę wraz z numerem domu i mieszkania:');
    twiml.say({ language: 'pl-PL', voice: 'Polly.Ola-Neural' }, 'Nie usłyszałem ulicy. Spróbuj ponownie.');
    twiml.redirect(`${BASE_URL}/voice/krok2`);

    res.type('text/xml');
    res.send(twiml.toString());
});

app.post('/voice/krok3', (req, res) => {
    const callSid = req.body.CallSid;
    const street = req.body.SpeechResult || '';
    const session = sessions.get(callSid) || {};
    session.street = street;
    sessions.set(callSid, session);
    console.log(`[${callSid}] Ulica: "${street}"`);

    const twiml = new VoiceResponse();
    const gather = twiml.gather({
        input: 'speech', language: 'pl-PL',
        speechTimeout: 'auto', timeout: 15,
        action: `${BASE_URL}/voice/krok4`, method: 'POST'
    });
    gather.say({ language: 'pl-PL', voice: 'Polly.Ola-Neural' }, 'Proszę opisać awarię:');
    twiml.say({ language: 'pl-PL', voice: 'Polly.Ola-Neural' }, 'Nie usłyszałem opisu. Spróbuj ponownie.');
    twiml.redirect(`${BASE_URL}/voice/krok3`);

    res.type('text/xml');
    res.send(twiml.toString());
});

app.post('/voice/krok4', (req, res) => {
    const callSid = req.body.CallSid;
    const problem = req.body.SpeechResult || '';
    const session = sessions.get(callSid) || {};
    session.problem = problem;
    sessions.set(callSid, session);
    console.log(`[${callSid}] Awaria: "${problem}"`);

    const twiml = new VoiceResponse();
    twiml.say({ language: 'pl-PL', voice: 'Polly.Ola-Neural' },
        'Dziękujemy. Chwilę proszę, sprawdzam zgłoszenie.');
    twiml.redirect(`${BASE_URL}/voice/przetworz`);

    res.type('text/xml');
    res.send(twiml.toString());
});

app.post('/voice/przetworz', async (req, res) => {
    const callSid = req.body.CallSid;
    const session = sessions.get(callSid) || {};
    const twiml = new VoiceResponse();

    try {
        const parsed = await parseAddressData(
            callSid,
            session.city || '',
            session.street || '',
            session.problem || ''
        );

        if (!parsed) {
            twiml.say({ language: 'pl-PL', voice: 'Polly.Ola-Neural' },
                'Nie udało się rozpoznać adresu. Spróbujmy jeszcze raz.');
            twiml.redirect(`${BASE_URL}/voice`);
            res.type('text/xml').send(twiml.toString());
            return;
        }

        session.parsed = parsed;
        sessions.set(callSid, session);

        const flatTekst = parsed.data.flat && parsed.data.flat !== 'BRAK'
            ? `, mieszkanie ${parsed.data.flat}`
            : '';
        const streetCleaned = parsed.data.street.replace(/^(ul\.|ulica|al\.|aleja|aleje|pl\.|plac|os\.|osiedle)\s+/i, '').trim();
        const adresGlos = `${parsed.data.city}, ulica ${streetCleaned}, numer ${parsed.data.number}${flatTekst}`;

        const gather = twiml.gather({
            input: 'dtmf',
            numDigits: 1,
            timeout: 10,
            action: `${BASE_URL}/voice/potwierdz`,
            method: 'POST'
        });
        gather.say({ language: 'pl-PL', voice: 'Polly.Ola-Neural' },
            `Czy zgłoszenie dotyczy adresu: ${adresGlos}? Aby potwierdzić, naciśnij 1. Aby podać dane ponownie, naciśnij 2.`);
        twiml.say({ language: 'pl-PL', voice: 'Polly.Ola-Neural' }, 'Nie odebraliśmy odpowiedzi. Spróbujmy jeszcze raz.');
        twiml.redirect(`${BASE_URL}/voice`);

        res.type('text/xml').send(twiml.toString());
} catch (err) {
        console.error(`[${callSid}] Błąd /voice/przetworz:`, err.message);
        sessions.delete(callSid);
        twiml.say({ language: 'pl-PL', voice: 'Polly.Ola-Neural' },
            'Przepraszamy, wystąpił problem z systemem. Spróbujmy jeszcze raz.');
        twiml.redirect(`${BASE_URL}/voice/awaria`);
        res.type('text/xml').send(twiml.toString());
    }
});

async function parseAddressData(callSid, city, street, problem) {
    const gptResponse = await axios.post(
        'https://api.openai.com/v1/chat/completions',
        {
            model: 'gpt-4o-mini',
            messages: [
                {
                    role: 'system',
                    content: `Wyciągnij dane adresowe z tekstu i zwróć JSON bez komentarzy:
{
  "city": "",
  "street": "",
  "number": "",
  "flat": "",
  "problem": ""
}
Zasady:
- popraw błędy wymowy i zapisu (np. "swietochlowice" → "Świętochłowice", "halupki" → "Chałupki", "gołembia" → "Gołębia")
- ZAWSZE zapisuj nazwę ulicy w MIANOWNIKU (forma podstawowa, jak na tabliczce z nazwą ulicy): np. "na Chałupkach" → "Chałupki", "z Gołębiej" → "Gołębia", "do Marii Dulcissimy Hoffmann" → "Marii Dulcissimy Hoffmann"
- ZAWSZE zapisuj nazwę miasta w MIANOWNIKU: np. "w Świętochłowicach" → "Świętochłowice", "w Chorzowie" → "Chorzów"
- ZAWSZE używaj polskich znaków diakrytycznych (ą, ć, ę, ł, ń, ó, ś, ź, ż) tam gdzie powinny być
- UWAGA: nazwy ulic w Polsce często zaczynają się od liczby np. "11 Listopada", "1 Maja", "3 Maja", "29 Stycznia" - cała nazwa to ulica, nie mylić z numerem budynku
- numer budynku to liczba podana PO nazwie ulicy, np. "11 Listopada 64" → street: "11 Listopada", number: "64"
- flat to numer mieszkania jeśli podano po "/", np. "64/5" → number: "64", flat: "5"
- liczby wymawiane np. "sześćdziesiąt cztery" → "64"
- numer budynku może zawierać jedną literę bezpośrednio po cyfrach np. "139a", "95k"
- numer mieszkania to osobna liczba PO numerze budynku, np. "139a trzynaście" → number: "139a", flat: "13" - NIE łącz w "139a13"
- słowo "przez" oznacza separator między numerem budynku a mieszkaniem, np. "139a przez 13" → number: "139a", flat: "13"
- pole "street" zawiera TYLKO nazwę ulicy BEZ słów "ul.", "ulica", "al.", "aleja", "pl.", "plac", "os.", "osiedle" - usuń je z początku nazwy ulicy
- jeśli brak danych wpisz "BRAK"
- zwróć tylko JSON`
                },
                {
                    role: 'user',
                    content: `Miasto: ${city}\nUlica i numer: ${street}\nAwaria: ${problem}`
                }
            ]
        },
        {
            headers: { 'Authorization': `Bearer ${process.env.OPENAI_API_KEY}` },
            timeout: 10000
        }
    );

    let raw = gptResponse.data.choices[0].message.content
        .replace(/```json/g, '').replace(/```/g, '').trim();
    const data = JSON.parse(raw);
    console.log(`[${callSid}] Dane z GPT:`, data);

    if (data.number && typeof data.number === 'string') {
        data.number = data.number.toLowerCase().replace(/\s+/g, '');
    }
    if (data.flat && typeof data.flat === 'string') {
        data.flat = data.flat.toLowerCase().replace(/\s+/g, '');
    }

    const isBadData =
        !data.city || data.city === 'BRAK' ||
        !data.street || data.street === 'BRAK' ||
        !data.number || data.number === 'BRAK' ||
        !data.problem || data.problem === 'BRAK';

    if (isBadData) return null;

    data.street = normalizujUlice(data.street);
    const firma = findFirma(data.city, data.street, data.number);
    const isValid = !!firma;
    const flatInfo = data.flat && data.flat !== 'BRAK' ? `/${data.flat}` : '';
    const streetCleaned = data.street.replace(/^(ul\.|ulica|al\.|aleja|aleje|pl\.|plac|os\.|osiedle)\s+/i, '').trim();
    const adres = `${data.city}, ul. ${streetCleaned} ${data.number}${flatInfo}`;

    console.log(`[${callSid}] Firma: ${firma}, Obsługiwany: ${isValid}`);
    return { data, firma, isValid, adres };
}

async function sendNotifications(callSid, callerPhone, parsed) {
    const { data, firma, isValid, adres } = parsed;

    if (callerPhone) {
        if (isValid) {
            await sendSms(callerPhone, `Dziękujemy za zgłoszenie.\nAdres: ${adres}\nFirma: ${firma}`);
        } else {
            await sendSms(callerPhone, `Przepraszamy, nie obsługujemy tego adresu:\n${adres}\n\nJeżeli podany wyżej adres jest nieprawidłowy, prosimy o ponowne skontaktowanie się.`);
        }
    }

    const msgTel = `Nowe zgłoszenie (tel):
Firma: ${firma || 'NIEZNANA'}
Telefon: ${callerPhone}
Adres: ${adres}
Awaria: ${data.problem}`;
    if (isValid) {
        await sendTelegram(msgTel, process.env.TELEGRAM_THREAD_WORKERS);
    }
    await sendTelegram(msgTel + `\nObsługiwany: ${isValid ? 'TAK' : 'NIE'}`, process.env.TELEGRAM_THREAD_ALL);

    console.log(`[${callSid}] Telegram wysłany`);
}

app.post('/voice/potwierdz', (req, res) => {
    const callSid = req.body.CallSid;
    const digit = (req.body.Digits || '').trim();
    const session = sessions.get(callSid) || {};
    const twiml = new VoiceResponse();

    console.log(`[${callSid}] Potwierdzenie: digit="${digit}"`);

    if (digit === '1' && session.parsed) {
        const parsed = session.parsed;
        const callerPhone = session.callerPhone || '';

        if (parsed.isValid) {
            const godz = godzinaDojazdu();
            twiml.say({ language: 'pl-PL', voice: 'Polly.Ola-Neural' },
                `Dziękujemy za zgłoszenie. Przewidywany dojazd do godziny ${godz}.`);
        } else {
            twiml.say({ language: 'pl-PL', voice: 'Polly.Ola-Neural' },
                'Niestety, podany adres nie znajduje się w obszarze naszej obsługi. Otrzymasz wiadomość SMS z informacją.');
        }
        res.type('text/xml').send(twiml.toString());

        sendNotifications(callSid, callerPhone, parsed)
            .catch(err => console.error(`[${callSid}] Błąd notifications:`, err.message));
        sessions.delete(callSid);
    } else if (digit === '2') {
        sessions.delete(callSid);
        twiml.say({ language: 'pl-PL', voice: 'Polly.Ola-Neural' },
            'Dobrze, podajmy dane jeszcze raz.');
        twiml.redirect(`${BASE_URL}/voice/awaria`);
        res.type('text/xml').send(twiml.toString());
    } else {
        twiml.say({ language: 'pl-PL', voice: 'Polly.Ola-Neural' },
            'Nie odebraliśmy odpowiedzi. Spróbujmy jeszcze raz.');
        twiml.redirect(`${BASE_URL}/voice`);
        res.type('text/xml').send(twiml.toString());
    }
});

app.post('/sms', async (req, res) => {
    const incomingMsg = req.body.Body || '';
    const phone = req.body.From || '';
    console.log('SMS OD KLIENTA:', incomingMsg);
    res.send('<Response></Response>');

    try {
        const gptResponse = await axios.post(
            'https://api.openai.com/v1/chat/completions',
            {
                model: 'gpt-4o-mini',
                messages: [
                    {
                        role: 'system',
                        content: `Wyciągnij dane z tekstu i zwróć JSON bez komentarzy:
{
  "city": "",
  "street": "",
  "number": "",
  "flat": "",
  "problem": ""
}
Zasady:
- popraw błędy zapisu (np. "swietochlowice" → "Świętochłowice", "halupki" → "Chałupki", "gołembia" → "Gołębia")
- ZAWSZE zapisuj nazwę ulicy w MIANOWNIKU (forma podstawowa, jak na tabliczce): np. "na Chałupkach" → "Chałupki", "z Gołębiej" → "Gołębia"
- ZAWSZE zapisuj nazwę miasta w MIANOWNIKU: np. "w Świętochłowicach" → "Świętochłowice", "w Chorzowie" → "Chorzów"
- ZAWSZE używaj polskich znaków diakrytycznych (ą, ć, ę, ł, ń, ó, ś, ź, ż) tam gdzie powinny być
- UWAGA: nazwy ulic w Polsce często zaczynają się od liczby np. "11 Listopada", "1 Maja", "3 Maja" - cała nazwa to ulica, nie mylić z numerem budynku
- numer budynku to liczba podana PO nazwie ulicy, np. "11 Listopada 64" → street: "11 Listopada", number: "64"
- flat to numer mieszkania jeśli podano po "/", np. "64/5" → number: "64", flat: "5"
- numer budynku może zawierać jedną literę bezpośrednio po cyfrach np. "139a", "95k"
- numer mieszkania to osobna liczba PO numerze budynku, np. "139a 13" → number: "139a", flat: "13" - NIE łącz w "139a13"
- słowo "przez" oznacza separator między numerem budynku a mieszkaniem, np. "139a przez 13" → number: "139a", flat: "13"
- pole "street" zawiera TYLKO nazwę ulicy BEZ słów "ul.", "ulica", "al.", "aleja", "pl.", "plac", "os.", "osiedle" - usuń je z początku nazwy ulicy
- jeśli brak danych wpisz "BRAK"
- zwróć tylko JSON`
                    },
                    { role: 'user', content: incomingMsg }
                ]
            },
            {
                headers: { 'Authorization': `Bearer ${process.env.OPENAI_API_KEY}` },
                timeout: 10000
            }
        );

        let raw = gptResponse.data.choices[0].message.content
            .replace(/```json/g, '').replace(/```/g, '').trim();
        const data = JSON.parse(raw);
        console.log('DANE Z SMS:', data);

        data.street = normalizujUlice(data.street);
        const firma = findFirma(data.city, data.street, data.number);
        const isValidAddress = !!firma;
        const flatInfo = data.flat && data.flat !== 'BRAK' ? `/${data.flat}` : '';
        const streetCleaned = data.street.replace(/^(ul\.|ulica|al\.|aleja|aleje|pl\.|plac|os\.|osiedle)\s+/i, '').trim();
        const adres = `${data.city}, ul. ${streetCleaned} ${data.number}${flatInfo}`;

        console.log('FIRMA:', firma, 'OBSŁUGIWANY:', isValidAddress);

        const msgSms = `Nowe zgłoszenie (SMS):
Firma: ${firma || 'NIEZNANA'}
Telefon: ${phone}
Adres: ${adres}
Awaria: ${data.problem}`;

        if (isValidAddress) {
            await sendTelegram(msgSms, process.env.TELEGRAM_THREAD_WORKERS);
            await sendSms(phone, `Dziękujemy, zgłoszenie przyjęte:\n${adres}`);
        } else {
            await sendSms(phone, `Przepraszamy, nie obsługujemy tego adresu:\n${adres}\n\nJeżeli podany wyżej adres jest nieprawidłowy, prosimy o ponowne skontaktowanie się.`);
        }
        await sendTelegram(msgSms + `\nObsługiwany: ${isValidAddress ? 'TAK' : 'NIE'}`, process.env.TELEGRAM_THREAD_ALL);

    } catch (err) {
        console.error('BŁĄD SMS:', err.message);
    }
});

const PORT = process.env.PORT || 3000;
app.post('/voice/transfer_complete', (req, res) => {
    const twiml = new VoiceResponse();
    const dialStatus = req.body.DialCallStatus || '';
    console.log(`Transfer do konsultanta: ${dialStatus}`);
    console.log(`Szczegóły transferu:`, req.body);
    
    // Jeśli połączenie się powiodło, zakończ
    if (dialStatus === 'completed' || dialStatus === 'answered') {
        twiml.hangup();
    } else {
        // Jeśli nie, wróć do menu
        twiml.say({ language: 'pl-PL', voice: 'Polly.Ola-Neural' },
            'Konsultant jest teraz zajęty. Proszę zadzwonić ponownie.');
        twiml.redirect(`${BASE_URL}/voice`);
    }
    
    res.type('text/xml').send(twiml.toString());
});

app.post('/voice/po_polaczeniu', (req, res) => {
    const twiml = new VoiceResponse();
    const dialStatus = req.body.DialCallStatus || '';
    console.log(`Po połączeniu z konsultantem: ${dialStatus}`);
    if (dialStatus !== 'completed') {
        twiml.say({ language: 'pl-PL', voice: 'Polly.Ola-Neural' },
            'Konsultant jest teraz zajęty, prosimy zadzwonić później.');
    }
    twiml.hangup();
    res.type('text/xml').send(twiml.toString());
});

app.listen(PORT, () => console.log(`Serwer działa na porcie ${PORT}`));
