require('dotenv').config();

const express = require('express');
const bodyParser = require('body-parser');
const { VoiceResponse } = require('twilio').twiml;
const axios = require('axios');
const FormData = require('form-data');
const fs = require('fs');

const BASE_URL = process.env.BASE_URL || 'https://pogotowie-production.up.railway.app';
const DOJAZD_MINUT = parseInt(process.env.DOJAZD_MINUT || '60');

const EXCLUDED_NUMBERS = (process.env.EXCLUDED_NUMBERS || '').split(',').map(n => n.trim()).filter(Boolean);
const FORWARD_TO = process.env.FORWARD_TO || '';

// Twilio - tylko do obsługi połączeń głosowych
const twilioClient = require('twilio')(
    process.env.TWILIO_SID,
    process.env.TWILIO_AUTH_TOKEN
);

// Telegram - powiadomienia do pracowników (bezpłatne)
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

// SMSAPI - wysyłanie SMS-ów do klientów
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

const app = express();
app.use(bodyParser.urlencoded({ extended: false }));
app.use(bodyParser.json());

const sessions = new Map();

function normalize(text) {
    if (!text) return '';
    return text
        .toLowerCase()
        .replace(/ł/g, 'l')
        .replace(/Ł/g, 'l')
        .normalize("NFD")
        .replace(/[\u0300-\u036f]/g, '')
        .replace(/[-/]/g, ' ')
        .replace(/\./g, '')
        .replace(/,/g, '')
        .replace(/\s+/g, ' ')
        .trim();
}

function simplifyAddress(text) {
    return normalize(text)
        .replace(/\b(ul|ulica|al|aleja|aleje|pl|plac|os|osiedle|skwer|dr|doktora|ks|ksiedza|sw|swietego|swietej|gen|generala|prof|profesora|im|imienia)\b/g, '')
        .split(' ')
        .filter(word => word.length > 1 || /^\d+$/.test(word))
        .join(' ')
        .replace(/\s+/g, ' ')
        .trim();
}

function tokenize(text) {
    return simplifyAddress(text).split(' ').filter(p => p.length > 0);
}

function tokensMatch(a, b) {
    if (a === b) return true;
    if (/^\d/.test(a) || /^\d/.test(b)) return false;
    const minLen = Math.min(a.length, b.length);
    if (minLen < 5) return false;
    const minPrefix = Math.max(5, Math.floor(minLen * 0.7));
    let i = 0;
    while (i < minLen && a[i] === b[i]) i++;
    return i >= minPrefix;
}

function tokenInList(token, list) {
    return list.some(c => tokensMatch(token, c));
}

function addressesMatch(inputCityTokens, inputStreetTokens, inputNumber, candidateText) {
    const candidateTokens = tokenize(candidateText);

    const streetMatch = inputStreetTokens.every(t => tokenInList(t, candidateTokens));
    if (!streetMatch) return false;

    const cityMatch = inputCityTokens.every(t => tokenInList(t, candidateTokens));
    if (!cityMatch) return false;

    if (inputNumber && inputNumber !== 'brak') {
        const num = normalize(inputNumber);
        return candidateTokens.some(t => t === num);
    }
    return true;
}


function loadAddresses(file) {
    try {
        return fs.readFileSync(file, 'utf-8')
            .split('\n')
            .map(line => line.trim())
            .filter(line => line.length > 0);
    } catch (e) {
        console.error(`Błąd wczytywania pliku ${file}:`, e.message);
        return [];
    }
}

const mpglAddresses = loadAddresses('adresy/mpgl.txt');
const sdsmAddresses = loadAddresses('adresy/sdsm.txt');
const barbaraAddresses = loadAddresses('adresy/sm-barbara.txt');

console.log(`Załadowano adresów: MPGL=${mpglAddresses.length}, SDSM=${sdsmAddresses.length}, Barbara=${barbaraAddresses.length}`);

function findFirma(city, street, number) {
    const inputCityTokens = tokenize(city);
    const inputStreetTokens = tokenize(street);
    const inputNumber = normalize(number || '');
    console.log(`SZUKAM: miasto=[${inputCityTokens}] ulica=[${inputStreetTokens}] numer=[${inputNumber}]`);
    const lists = [
        { name: 'MPGL', list: mpglAddresses },
        { name: 'SDSM', list: sdsmAddresses },
        { name: 'SM BARBARA', list: barbaraAddresses },
    ];
    for (const { name, list } of lists) {
        const match = list.find(addr => {
            const result = addressesMatch(inputCityTokens, inputStreetTokens, inputNumber, addr);
            if (result) console.log(`DOPASOWANIE ${name}: "${addr}"`);
            return result;
        });
        if (match) return name;
    }
    console.log('BRAK DOPASOWANIA dla:', { city, street, number });
    return null;
}

function normalizujUlice(street) {
    const s = street.toLowerCase();
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

app.post('/voice', (req, res) => {
    const callSid = req.body.CallSid;
    const callerPhone = req.body.From || '';

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
        input: 'speech', language: 'pl-PL',
        speechTimeout: 'auto', timeout: 10,
        action: `${BASE_URL}/voice/krok2`, method: 'POST'
    });
    gather.say({ language: 'pl-PL', voice: 'Polly.Ola-Neural' }, 'Pogotowie awaryjne. Proszę podać miasto:');
    twiml.say({ language: 'pl-PL', voice: 'Polly.Ola-Neural' }, 'Nie usłyszałem miasta. Spróbuj ponownie.');
    twiml.redirect(`${BASE_URL}/voice`);

    res.type('text/xml');
    res.send(twiml.toString());
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

        const flatTekst = parsed.data.flat && parsed.data.flat !== "BRAK"
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
        twiml.say({ language: 'pl-PL', voice: 'Polly.Ola-Neural' },
            'Wystąpił błąd. Prosimy zadzwonić ponownie.');
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
        { headers: { 'Authorization': `Bearer ${process.env.OPENAI_API_KEY}` } }
    );

    let raw = gptResponse.data.choices[0].message.content
        .replace(/```json/g, '').replace(/```/g, '').trim();
    const data = JSON.parse(raw);
    console.log(`[${callSid}] Dane z GPT:`, data);

    const isBadData =
        !data.city || data.city === "BRAK" ||
        !data.street || data.street === "BRAK" ||
        !data.number || data.number === "BRAK" ||
        !data.problem || data.problem === "BRAK";

    if (isBadData) return null;

    data.street = normalizujUlice(data.street);
    const firma = findFirma(data.city, data.street, data.number);
    const isValid = !!firma;
    const flatInfo = data.flat && data.flat !== "BRAK" ? `/${data.flat}` : '';
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
        twiml.redirect(`${BASE_URL}/voice`);
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
    console.log("SMS OD KLIENTA:", incomingMsg);
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
            { headers: { 'Authorization': `Bearer ${process.env.OPENAI_API_KEY}` } }
        );

        let raw = gptResponse.data.choices[0].message.content
            .replace(/```json/g, '').replace(/```/g, '').trim();
        const data = JSON.parse(raw);
        console.log("DANE Z SMS:", data);

                data.street = normalizujUlice(data.street);
        const firma = findFirma(data.city, data.street, data.number);
        const isValidAddress = !!firma;
        const flatInfo = data.flat && data.flat !== "BRAK" ? `/${data.flat}` : '';
        const streetCleaned = data.street.replace(/^(ul\.|ulica|al\.|aleja|aleje|pl\.|plac|os\.|osiedle)\s+/i, '').trim();
const adres = `${data.city}, ul. ${streetCleaned} ${data.number}${flatInfo}`;

        console.log("FIRMA:", firma, "OBSŁUGIWANY:", isValidAddress);

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
        console.error("BŁĄD SMS:", err.message);
    }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`Serwer działa na porcie ${PORT}`));