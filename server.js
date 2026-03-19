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

const app = express();
app.use(bodyParser.urlencoded({ extended: false }));
function loadAddresses(file) {
    return fs.readFileSync(file, 'utf-8')
        const barbaraAddresses = loadAddresses('adresy/sm-barbara.txt');
}

const mpglAddresses = loadAddresses('adresy/mpgl.txt');
const sdsmAddresses = loadAddresses('adresy/sdsm.txt');
const barbaraAddresses = loadAddresses('adresy/sm-barbara.txt');
   

// --- PO£¥CZENIA G£OSOWE ---
app.post('/voice', (req, res) => {
    const twiml = new VoiceResponse();
    twiml.say(
        { language: 'pl-PL', voice: 'alice' },
        'Pogotowie awaryjne. Informujemy, ¿e rozmowa jest nagrywana. Proszê o podanie imienia, nazwiska i dok³adnego adresu awarii.'
    );
    twiml.record({
        maxLength: 120,
        action: '/process-recording',
    });
    res.type('text/xml');
    res.send(twiml.toString());
});

// --- OBS£UGA NAGRANIA ---
app.post('/process-recording', async (req, res) => {
    try {
        const recordingUrl = req.body.RecordingUrl;

        // Pobranie nagrania
        const response = await axios.get(recordingUrl, { responseType: 'arraybuffer' });
        const audioBuffer = Buffer.from(response.data);

        // Wysy³amy do OpenAI Whisper
        const formData = new FormData();
        formData.append('file', audioBuffer, 'nagranie.wav');
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

//  ANALIZA TEKSTU (GPT)
const gptResponse = await axios.post(
    'https://api.openai.com/v1/chat/completions',
    {
        model: 'gpt-4o-mini',
        messages: [
            {
                role: 'system',
                content: `Wyci¹gnij dane z tekstu i zwróæ JSON:
{
"name": "",
"city": "",
"street": "",
"number": "",
"problem": ""
}

Zasady:
- rozdziel ulicê i numer (np. "1 maja" i "2-4")
- rozpoznaj miasto nawet jeœli jest na koñcu
- popraw b³êdy (np. "swietochlowice" › "Œwiêtoch³owice")
- jeœli brak danych wpisz "BRAK"`

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

const data = JSON.parse(gptResponse.data.choices[0].message.content);

console.log('Dane:', data);
const addressText = normalize(data.address || "");

const fullAddress = normalize(
    `${data.city} ul ${data.street} ${data.number}`
);

console.log('Z³o¿ony adres:', fullAddress);

let firma = null;

if (mpglAddresses.some(addr => fullAddress.includes(addr))) {
    firma = 'MPGL';
} else if (sdsmAddresses.some(addr => fullAddress.includes(addr))) {
    firma = 'SDSM';
} else if (barbaraAddresses.some(addr => fullAddress.includes(addr))) {
    firma = 'SM BARBARA';
}

console.log('Firma:', firma);

   

console.log('Czy adres obs³ugiwany:', isValidAddress);


        // --- WYSY£ANIE SMS DO PRACOWNIKÓW ---
        const twilio = require('twilio')(process.env.TWILIO_SID, process.env.TWILIO_AUTH_TOKEN);

        const workers = [
            '+48XXXXXXXXX', // numer pracownika 1
            '+48XXXXXXXXX'  // numer pracownika 2
        ];

        for (const w of workers) {
            await twilio.messages.create({
                from: process.env.TWILIO_PHONE,
                to: w,
                body: `Nowe zg³oszenie:
Firma: ${firma || 'NIEZNANA'}
Imiê: ${data.name}
Adres: ${data.city}, ul. ${data.street} ${data.number}
Problem: ${data.problem}
Obs³ugiwany: ${isValidAddress ? 'TAK' : 'NIE'}`
            });
        }

        // OdpowiedŸ dla klienta
        const twiml = new VoiceResponse();
        twiml.say({ language: 'pl-PL', voice: 'alice' }, 'Dziêkujemy, zg³oszenie przyjête.');
        res.type('text/xml');
        res.send(twiml.toString());
   } catch (err) {
    console.error(err);
    res.status(500).send('B³¹d przetwarzania nagrania');
}
});

// --- SMSY PRZYCHODZ¥CE ---
app.post('/sms', (req, res) => {
    const incomingMsg = req.body.Body;
    const twiml = new MessagingResponse();
    twiml.message('Dziêkujemy za zg³oszenie');
    res.type('text/xml');
    res.send(twiml.toString());
});

// --- URUCHOMIENIE SERWERA ---
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`Server dziala na porcie ${PORT}`));
