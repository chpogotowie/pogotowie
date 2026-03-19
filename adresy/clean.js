const fs = require('fs');

function normalize(text) {
    return text
        .toLowerCase()
        .normalize("NFD")
        .replace(/[\u0300-\u036f]/g, '');
}

const input = fs.readFileSync('mpgl.txt', 'utf-8').split('\n');

let city = '';
const result = [];

for (let line of input) {
    line = line.trim();

    if (!line) continue;

    // wykrywanie miasta
    if (
        line.toLowerCase().includes('świętochłowice') ||
        line.toLowerCase().includes('chorzów')
    ) {
        city = normalize(line);
        continue;
    }

    // tylko linie z ulicą
    if (line.toLowerCase().includes('ul')) {
        const cleanLine = normalize(line)
            .replace(/\./g, '')
            .replace(/,/g, '');

        result.push(`${city} ${cleanLine}`);
    }
}

fs.writeFileSync('mpgl.txt', result.join('\n'));

console.log('✔ Gotowe: mpgl.txt');