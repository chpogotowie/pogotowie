require('dotenv').config();

const express = require('express');
const bodyParser = require('body-parser');
const { VoiceResponse } = require('twilio').twiml;

const app = express();
app.use(bodyParser.urlencoded({ extended: false }));

app.post('/voice', (req, res) => {
    const twiml = new VoiceResponse();

    twiml.say('Test dzia³a poprawnie');

    res.type('text/xml');
    res.send(twiml.toString());
});

app.get('/', (req, res) => {
    res.send('Server dzia³a');
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log('Server dzia³a'));