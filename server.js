console.log("TEST NOWEGO KODU 999");

require('dotenv').config();

function normalize(text) {
    return text
        .toLowerCase()
        .normalize("NFD")
        .replace(/[\u0300-\u036f]/g, '');
}

const express = require('express');
const bodyParser = require('body-parser');
const { MessagingResponse, VoiceResponse } = require('twilio').twiml;
const axios = require('axios');
const FormData = require('form-data');
const fs = require('fs');

const twilio = require('twilio')(
    process.env.TWILIO_SID,
    process.env.TWILIO_AUTH_TOKEN
);

const app = express();
app.use(bodyParser.urlencoded({ extended: false }));
function loadAddresses(file) {
    return fs.readFileSync(file, 'utf-8')
        .split('\n')
        .map(line => normalize(line.trim()))
        .filter(line => line.length > 5);
}

const mpglAddresses = loadAddresses('adresy/mpgl.txt');
const sdsmAddresses = loadAddresses('adresy/sdsm.txt');
const barbaraAddresses = loadAddresses('adresy/sm-barbara.txt');
   

// --- PO  CZENIA G OSOWE ---
app.post('/voice', (req, res) => {
    const twiml = new VoiceResponse();

    twiml.say(
        { language: 'pl-PL', voice: 'alice' },
        'Pogotowie awaryjne. Informujemy,  e rozmowa jest nagrywana. Prosz  o podanie imienia, nazwiska i dok adnego adresu awarii.'
    );

    twiml.record({
        maxLength: 120,
        action: 'https://pogotowie-production.up.railway.app/process-recording',
    });

    res.type('text/xml');
    res.send(twiml.toString());
});
// --- OBS UGA NAGRANIA ---
app.post('/process-recording', async (req, res) => {

    const twiml = new VoiceResponse();
    twiml.say('Dzi kujemy, zg oszenie przyj te');
    res.type('text/xml');
    res.send(twiml.toString());

    try {

        const recordingUrl = req.body.RecordingUrl;

        // Pobranie nagrania
        const response = await axios.get(recordingUrl + '.wav', {
            responseType: 'arraybuffer',
            auth: {
                username: process.env.TWILIO_SID,
                password: process.env.TWILIO_AUTH_TOKEN
            }
        });
const audioBuffer = Buffer.from(response.data);

console.log("? NAGRANIE POBRANE");

// Wysy amy do OpenAI Whisper
const formData = new FormData();
formData.append('file', audioBuffer, 'nagranie.wav'); // ?? TO MUSI BY 
formData.append('model', 'whisper-1');

const aiResponse = await axios.post(
    'https://api.openai.com/v1/audio/transcriptions',
    formData,
    {
        headers: {
            'Authorization': `Bearer ${process.env.OPENAI_API_KEY}`,
            ...formData.getHeaders()
        }
    }
);

        const transcribedText = aiResponse.data.text;
        console.log('Transkrypcja:', transcribedText);
console.log("TEKST Z WHISPER:", transcribedText);
console.log("? WHISPER OK");

//  ANALIZA TEKSTU (GPT)
const gptResponse = await axios.post(
    'https://api.openai.com/v1/chat/completions',
    {
        model: 'gpt-4o-mini',
        messages: [
            {
                role: 'system',
                content: `Wyci gnij dane z tekstu i zwr   JSON:
{
"name": "",
"city": "",
"street": "",
"number": "",
"problem": ""
}

Zasady:
- rozdziel ulic  i numer (np. "1 maja" i "2-4")
- rozpoznaj miasto nawet je li jest na ko cu
- popraw b  dy (np. "swietochlowice"   " wi toch owice")
- je li brak danych wpisz "BRAK"`

            },
            {
                role: 'user',
                content: transcribedText
            }
        ]
    },
    {
        headers: {
            'Authorization': `Bearer ${process.env.OPENAI_API_KEY}`
        }
    }
);

let raw = gptResponse.data.choices[0].message.content;

console.log("RAW GPT:", raw);

// usuwa ```json ```
raw = raw.replace(/```json/g, '').replace(/```/g, '').trim();

const data = JSON.parse(raw);
console.log("? GPT OK");

console.log("Dane po parsowaniu:", data);

console.log('Dane:', data);

const isBadData =
    !data.name || data.name === "BRAK" ||
    !data.city || data.city === "BRAK" ||
    !data.street || data.street === "BRAK" ||
    !data.number || data.number === "BRAK" ||
    !data.problem || data.problem === "BRAK";
if (isBadData) {
    console.log("? NIE ROZPOZNANO DANYCH - SMS do klienta");


    await twilio.messages.create({
        from: process.env.TWILIO_PHONE,
        to: req.body.From, // ?? klient
        body: `Nie uda o si  poprawnie rozpozna  zg oszenia.
Prosimy o wype nienie formularza:
https://twojastrona.pl/zgloszenie`
    });

    return; // ?? STOP   nie idzie dalej do pracownik w
}

const addressText = normalize(data.address || "");

const fullAddress = normalize(
    `${data.city} ul ${data.street} ${data.number}`
);

console.log('Z o ony adres:', fullAddress);

let firma = null;

if (mpglAddresses.some(addr => fullAddress.includes(addr))) {
    firma = 'MPGL';
} else if (sdsmAddresses.some(addr => fullAddress.includes(addr))) {
    firma = 'SDSM';
} else if (barbaraAddresses.some(addr => fullAddress.includes(addr))) {
    firma = 'SM BARBARA';
}

const isValidAddress = !!firma;

console.log('Firma:', firma);
console.log('Czy adres obs ugiwany:', isValidAddress);

        // --- WYSY ANIE SMS DO PRACOWNIK W ---


        const workers = [
            '+48660687951', // numer pracownika 1
        ];
console.log("?? WYSY AM SMS");

        for (const w of workers) {
const msg = await twilio.messages.create({
    from: process.env.TWILIO_PHONE,
    to: w,
    body: `Nowe zg oszenie:
Firma: ${firma || 'NIEZNANA'}
Imi : ${data.name}
Adres: ${data.city}, ul. ${data.street} ${data.number}
Problem: ${data.problem}
Obs ugiwany: ${isValidAddress ? 'TAK' : 'NIE'}`
});

console.log("SID:", msg.sid);
console.log("STATUS:", msg.status);
console.log(" wys ano do:", w);
}

        // Odpowied  dla klienta
      
   } catch (err) {
    console.error(err);
    res.status(500).send('B  d przetwarzania nagrania');
}
});

// --- SMSY PRZYCHODZ CE ---
app.post('/sms', (req, res) => {
    const incomingMsg = req.body.Body;
    const twiml = new MessagingResponse();
    twiml.message('Dzi kujemy za zg oszenie');
    res.type('text/xml');
    res.send(twiml.toString());
});

// --- URUCHOMIENIE SERWERA ---
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`Server dziala na porcie ${PORT}`));
