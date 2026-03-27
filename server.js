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
async function sendTelegram(message) {
    try {
        const response = await axios.post(
            `https://api.telegram.org/bot${process.env.TELEGRAM_BOT_TOKEN}/sendMessage`,
            { chat_id: process.env.TELEGRAM_CHAT_ID, text: message }
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
        .normalize("NFD")
        .replace(/[\u0300-\u036f]/g, '')
        .replace(/[-]/g, ' ')
        .replace(/\./g, '')
        .replace(/,/g, '')
        .replace(/\s+/g, ' ')
        .trim();
}

function stemWord(word) {
    return word
        .replace(/ej$/, 'a')
        .replace(/ą$/, 'a')
        .replace(/ego$/, '')
        .replace(/owie$/, '')
        .replace(/ie$/, 'a')
        .replace(/iego$/, '')
        .replace(/owy$/, 'owa')
        .replace(/owe$/, 'owa')
        .replace(/owym$/, 'owa')
        .replace(/y$/, 'a');
}

function simplifyAddress(text) {
    return normalize(text)
        .replace(/\b(ul|ulica|al|aleja|aleje|pl|plac|os|osiedle|skwer)\b/g, '')
        .split(' ')
        .filter(word => word.length > 1)
        .map(stemWord)
        .join(' ')
        .replace(/\s+/g, ' ')
        .trim();
}

function tokenize(text) {
    return simplifyAddress(text).split(' ').filter(p => p.length > 0);
}

function addressesMatch(inputCityTokens, inputStreetTokens, inputNumber, candidateText) {
    const candidateTokens = tokenize(candidateText);
    const streetMatch = inputStreetTokens.every(t => candidateTokens.includes(t));
    if (!streetMatch) return false;
    const cityMatch = inputCityTokens.every(t => candidateTokens.includes(t));
    if (!cityMatch) return false;
    if (inputNumber && inputNumber !== 'brak') {
        const num = inputNumber.toLowerCase().trim();
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
    const inputNumber = (number || '').toLowerCase().trim();
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
    return null;
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
    gather.say({ language: 'pl-PL', voice: 'alice' }, 'Pogotowie awaryjne. Proszę podać miasto:');
    twiml.say({ language: 'pl-PL', voice: 'alice' }, 'Nie usłyszałem miasta. Spróbuj ponownie.');
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
    gather.say({ language: 'pl-PL', voice: 'alice' }, 'Proszę podać ulicę wraz z numerem domu i mieszkania:');
    twiml.say({ language: 'pl-PL', voice: 'alice' }, 'Nie usłyszałem ulicy. Spróbuj ponownie.');
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
    gather.say({ language: 'pl-PL', voice: 'alice' }, 'Proszę opisać awarię:');
    twiml.say({ language: 'pl-PL', voice: 'alice' }, 'Nie usłyszałem opisu. Spróbuj ponownie.');
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

    const godz = godzinaDojazdu();
    const twiml = new VoiceResponse();
    twiml.pause({ length: 6 });
    twiml.say({ language: 'pl-PL', voice: 'alice' },
        `Dziękujemy za zgłoszenie. Przewidywany dojazd do godziny ${godz}.`);

    res.type('text/xml');
    res.send(twiml.toString());

    processVoiceSession(callSid, session).catch(err => {
        console.error(`[${callSid}] Błąd:`, err);
    });
});

async function processVoiceSession(callSid, session) {
    try {
        const { callerPhone, city = '', street = '', problem = '' } = session;
        sessions.delete(callSid);

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
- popraw błędy wymowy i zapisu (np. "swietochlowice" → "Świętochłowice")
- UWAGA: nazwy ulic w Polsce często zaczynają się od liczby np. "11 Listopada", "1 Maja", "3 Maja", "29 Stycznia" - cała nazwa to ulica, nie mylić z numerem budynku
- numer budynku to liczba podana PO nazwie ulicy, np. "11 Listopada 64" → street: "11 Listopada", number: "64"
- flat to numer mieszkania jeśli podano po "/", np. "64/5" → number: "64", flat: "5"
- liczby wymawiane np. "sześćdziesiąt cztery" → "64"
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

        if (isBadData) {
            if (callerPhone) {
                await sendSms(callerPhone, `Nie udało się rozpoznać zgłoszenia.\nProsimy o SMS w formacie:\nAdres:\nAwaria:`);
            }
            return;
        }

        const firma = findFirma(data.city, data.street, data.number);
        const isValidAddress = !!firma;
        const flatInfo = data.flat && data.flat !== "BRAK" ? `/${data.flat}` : '';
        const adres = `${data.city}, ul. ${data.street} ${data.number}${flatInfo}`;

        console.log(`[${callSid}] Firma: ${firma}, Obsługiwany: ${isValidAddress}`);

        if (callerPhone) {
            if (isValidAddress) {
                await sendSms(callerPhone, `Dziękujemy za zgłoszenie.\nAdres: ${adres}\nFirma: ${firma}`);
            } else {
                await sendSms(callerPhone, `Przepraszamy, nie obsługujemy tego adresu:\n${adres}\n\nJeżeli podany wyżej adres jest nieprawidłowy, prosimy o ponowne skontaktowanie się.`);
            }
        }

        await sendTelegram(`Nowe zgłoszenie (tel):
Firma: ${firma || 'NIEZNANA'}
Telefon: ${callerPhone}
Adres: ${adres}
Awaria: ${data.problem}
Obsługiwany: ${isValidAddress ? 'TAK' : 'NIE'}`);
        console.log(`[${callSid}] Telegram wysłany`);

    } catch (err) {
        console.error(`[${callSid}] Błąd processVoiceSession:`, err.message);
    }
}

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
- popraw błędy zapisu (np. "swietochlowice" → "Świętochłowice")
- UWAGA: nazwy ulic w Polsce często zaczynają się od liczby np. "11 Listopada", "1 Maja", "3 Maja" - cała nazwa to ulica, nie mylić z numerem budynku
- numer budynku to liczba podana PO nazwie ulicy, np. "11 Listopada 64" → street: "11 Listopada", number: "64"
- flat to numer mieszkania jeśli podano po "/", np. "64/5" → number: "64", flat: "5"
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

        const firma = findFirma(data.city, data.street, data.number);
        const isValidAddress = !!firma;
        const flatInfo = data.flat && data.flat !== "BRAK" ? `/${data.flat}` : '';
        const adres = `${data.city}, ul. ${data.street} ${data.number}${flatInfo}`;

        console.log("FIRMA:", firma, "OBSŁUGIWANY:", isValidAddress);

        if (isValidAddress) {
            await sendTelegram(`Nowe zgłoszenie (SMS):
Firma: ${firma}
Telefon: ${phone}
Adres: ${adres}
Awaria: ${data.problem}`);

            await sendSms(phone, `Dziękujemy, zgłoszenie przyjęte:\n${adres}`);
        } else {
            await sendSms(phone, `Przepraszamy, nie obsługujemy tego adresu:\n${adres}\n\nJeżeli podany wyżej adres jest nieprawidłowy, prosimy o ponowne skontaktowanie się.`);
        }

    } catch (err) {
        console.error("BŁĄD SMS:", err.message);
    }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`Serwer działa na porcie ${PORT}`));