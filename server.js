console.log("TEST NOWEGO KODU 999");

require('dotenv').config();

function normalize(text) {
    return text
        .toLowerCase()
        .normalize("NFD")
        .replace(/[\u0300-\u036f]/g, '')
        .replace(/\./g, '')
        .replace(/,/g, '')
        .replace(/\s+/g, ' ')
        .replace(/\s([0-9]+)\s([a-z])/g, '$1$2')
        .trim();
}

function simplifyAddress(text) {
    return normalize(text)
.replace(/\bul\w*\b/g, '')   // usuwa wszystkie formy "ulica"
        .split(' ')
        .filter(word => word.length > 2)
        .map(word => {
            return word
                .replace(/ej$/, 'a')
                .replace(/ą$/, 'a')
                .replace(/ego$/, '')
                .replace(/ie$/, 'a')
                .replace(/y$/, 'a');
        })
        .join(' ')
        .trim();
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
        'Pogotowie awaryjne. Informujemy,  e rozmowa jest nagrywana. Prosze o podanie imienia, nazwiska i dokladnego adresu awarii.'
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
    twiml.say('Dziekujemy, zgloszenie przyjete');
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

const fullAddress = simplifyAddress(
    `${data.city} ${data.street} ${data.number}`
);

console.log("FULL RAW:", fullAddress);
console.log("FULL JSON:", JSON.stringify(fullAddress));
console.log("FULL LENGTH:", fullAddress.length);

const allAddresses = [
    ...mpglAddresses,
    ...sdsmAddresses,
    ...barbaraAddresses
];

allAddresses.forEach(addr => {
    const simplified = simplifyAddress(addr);

    if (
        fullAddress.includes(simplified) ||
        simplified.includes(fullAddress)
    ) {
        console.log("MATCH:", simplified);
    } else {
        console.log("BRAK:", simplified);
    }
});


console.log('Złożony adres:', fullAddress);

console.log("SZUKAM:", fullAddress);

console.log("=== LISTA MPGL ===");
mpglAddresses.slice(0, 5).forEach(addr => {
    console.log("MPGL RAW:", addr);
    console.log("MPGL SIMPLIFIED:", simplifyAddress(addr));
});

const found = mpglAddresses.find(addr => {
    const simplifiedAddr = simplifyAddress(addr);

    return fullAddress.includes(simplifiedAddr) ||
           simplifiedAddr.includes(fullAddress);
});

console.log("ZNALEZIONY:", found);

let firma = null;


if (mpglAddresses.some(addr => {
    const simplifiedAddr = simplifyAddress(addr);

    return fullAddress.includes(simplifiedAddr) ||
           simplifiedAddr.includes(fullAddress);
})) {
    firma = 'MPGL';

} else if (sdsmAddresses.some(addr => {
    const simplifiedAddr = simplifyAddress(addr);

    return fullAddress.includes(simplifiedAddr) ||
           simplifiedAddr.includes(fullAddress);
})) {
    firma = 'SDSM';

} else if (barbaraAddresses.some(addr => {
    const simplifiedAddr = simplifyAddress(addr);

    return fullAddress.includes(simplifiedAddr) ||
           simplifiedAddr.includes(fullAddress);
})) {
    firma = 'SM BARBARA';
}

const isValidAddress = !!firma;

console.log('Firma:', firma);
console.log('Czy adres obsługiwany:', isValidAddress);


// --- SMS DO KLIENTA ---
if (req.body.From) {
    if (isValidAddress) {
        await twilio.messages.create({
            from: process.env.TWILIO_PHONE,
            to: req.body.From,
            body: `Dziękujemy za zgłoszenie
Adres: ${data.city}, ul. ${data.street} ${data.number}
Firma: ${firma}`
        });
    } else {
        await twilio.messages.create({
            from: process.env.TWILIO_PHONE,
            to: req.body.From,
            body: `Przepraszamy, nie obsługujemy tego adresu:
${data.city}, ul. ${data.street} ${data.number}

Jeżeli adres jest nieprawidłowy, wyślij SMS w formacie:

Imię Nazwisko:
Adres:
Problem:`
        });
    }
}


        // --- WYSY ANIE SMS DO PRACOWNIK W ---


        const workers = [
            '+48660687951', // numer pracownika 1
        ];
console.log("?? WYSY AM SMS");

        for (const w of workers) {
const msg = await twilio.messages.create({
    from: process.env.TWILIO_PHONE,
    to: w,
    body: `Nowe zgloszenie:
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
app.post('/sms', async (req, res) => {
    const incomingMsg = req.body.Body;

    console.log("SMS OD KLIENTA:", incomingMsg);

    try {
        // --- GPT ANALIZA ---
        const gptResponse = await axios.post(
            'https://api.openai.com/v1/chat/completions',
            {
                model: 'gpt-4o-mini',
                messages: [
                    {
                        role: 'system',
                        content: `Wyciągnij dane z tekstu i zwróć JSON:
{
"name": "",
"city": "",
"street": "",
"number": "",
"problem": ""
}`
                    },
                    {
                        role: 'user',
                        content: incomingMsg
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
        raw = raw.replace(/```json/g, '').replace(/```/g, '').trim();

        const data = JSON.parse(raw);

        console.log("DANE Z SMS:", data);

        const fullAddress = simplifyAddress(
            `${data.city} ${data.street} ${data.number}`
        );

        let firma = null;

        if (mpglAddresses.some(addr => {
            const s = simplifyAddress(addr);
            return fullAddress.includes(s) || s.includes(fullAddress);
        })) {
            firma = 'MPGL';

        } else if (sdsmAddresses.some(addr => {
            const s = simplifyAddress(addr);
            return fullAddress.includes(s) || s.includes(fullAddress);
        })) {
            firma = 'SDSM';

        } else if (barbaraAddresses.some(addr => {
            const s = simplifyAddress(addr);
            return fullAddress.includes(s) || s.includes(fullAddress);
        })) {
            firma = 'SM BARBARA';
        }

        const isValidAddress = !!firma;

        console.log("FIRMA:", firma);
        console.log("OBSŁUGIWANY:", isValidAddress);

        // JEŚLI POPRAWNY
        if (isValidAddress) {

            // SMS do pracownika
            await twilio.messages.create({
                from: process.env.TWILIO_PHONE,
                to: '+48660687951',
                body: `Nowe zgłoszenie (SMS):
Firma: ${firma}
Imię: ${data.name}
Adres: ${data.city}, ul. ${data.street} ${data.number}
Problem: ${data.problem}`
            });

            // SMS do klienta
            await twilio.messages.create({
                from: process.env.TWILIO_PHONE,
                to: req.body.From,
                body: `Dziękujemy, zgłoszenie przyjęte:
${data.city}, ul. ${data.street} ${data.number}`
            });

        } else {
            // NADAL NIE OBSŁUGIWANY
            await twilio.messages.create({
                from: process.env.TWILIO_PHONE,
                to: req.body.From,
                body: `Przepraszamy, nie obsługujemy tego adresu.
Prosimy skontaktować się z inną firmą.`
            });
        }

    } catch (err) {
        console.error("BŁĄD SMS:", err);
    }

    res.send('<Response></Response>');
});

// --- URUCHOMIENIE SERWERA ---
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`Server dziala na porcie ${PORT}`));
