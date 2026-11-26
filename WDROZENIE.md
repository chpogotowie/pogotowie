# Bot pogotowia: wdrożenie i weryfikacja

Zmiana powstała na bazie `main`, commit `fca809c`, w gałęzi
`codex/language-address-confirmation`. Nie zmienia plików `adresy/` ani przypisań
firm. `Pacoca_fixed.sol` jest poza zakresem zmiany.

## Co zmienia kod

- Początek połączenia: „Aby rozmawiać po polsku, naciśnij 1. For English, press 2.”
  Dwie części są odczytywane właściwymi głosami. Jeden błędny klawisz lub cisza
  powtarza menu; drugi taki wynik wybiera polski.
- Język jest przechowywany przy `CallSid`. Dotyczy wszystkich komunikatów,
  parametrów rozpoznawania mowy, ponownego podawania danych i SMS do rozmówcy.
  Dotychczasowe menu awaria/konsultant pojawia się po wyborze języka.
- Twilio nadal rozpoznaje mowę przez `<Gather>`. OpenAI nadal korzysta z
  `POST /v1/chat/completions`, modelu `gpt-4o-mini`; otrzymuje ścisły schemat JSON.
  AI wyodrębnia dane i tłumaczy opis awarii na polski. Nazwy ulic nie są tłumaczone.
- `9/13` oznacza budynek 9 i mieszkanie 13. Nazwy typu „11 Listopada” zachowują
  liczby. Dosłowne nazwy i numery z transkrypcji mają pierwszeństwo przed propozycją AI.
- Dopasowanie obejmuje istniejące adresy, znaki diakrytyczne, skrócone/pełne nazwy,
  ograniczoną tolerancję literówek i wybrane odmiany nazw miejscowości.
  „Chorzów, Sabika 9/13” proponuje Stabika 9, mieszkanie 13 do potwierdzenia.
- Bot odczytuje adres i oczekuje DTMF: 1 potwierdza, 2 wybiera następny możliwy
  adres lub rozpoczyna jedną poprawkę, 3 zapisuje zgłoszenie jako niepewne.
  Po dwóch pustych/błędnych odpowiedziach zapisuje niepewne zgłoszenie.
- Firma zostaje przypisana dopiero po potwierdzeniu. Sprzeczne przypisania
  tej samej nieruchomości do kilku firm pozostają do ręcznej weryfikacji.
- Telegram zachowuje pola Firma, Telefon, Adres, Awaria i Obsługiwany.
  Dla niepotwierdzonych/niepełnych danych: Firma NIEZNANA, Obsługiwany NIEUSTALONE,
  dodatkowo przyczyna niepewności. Zachowywana jest również oryginalna treść
  wypowiedzi/SMS, która przy angielskiej rozmowie pozostaje po angielsku.
  Podstawowy opis awarii i etykiety są po polsku. Przy błędzie tłumaczenia opis
  zawiera polską informację o błędzie oraz oryginał, zamiast zmyślonego tłumaczenia.
- Zachowane: przekierowanie EXCLUDED_NUMBERS, konsultant, przyjmowanie SMS,
  SMSAPI, tematy Telegram ALL/WORKERS, przewidywany dojazd w czasie Warszawy.
  Zgłoszenia niepewne trafiają tylko do ALL. Błąd SMSAPI nie blokuje Telegrama.
  Długie wiadomości Telegram są dzielone na części.
- Dodano brakującą wcześniej trasę `/voice/po_polaczeniu` oraz `/health`.

## Testy lokalne

Wymagany Node.js 22 lub nowszy; użyto Node.js 24.14.0.

```powershell
cd C:\Users\wikoo\Documents\Dawkoz\pogotowie-review
npm ci --ignore-scripts
npm test
```

Testy uruchamiają prawdziwy Express i generator TwiML na lokalnym porcie.
Wywołania OpenAI, Telegram i SMSAPI zastępuje wstrzyknięta atrapa HTTP,
która odrzuca nieoczekiwane usługi. Nie jest tworzony klient wykonujący połączenia
Twilio. Testy nie wymagają sekretów ani pliku `.env`.

Zakres: wybór 1/2; błędne klawisze i cisza; język w całej rozmowie i przy poprawkach;
równoległe CallSid i numery telefonów; format polskiego zgłoszenia; adres bez i z
mieszkaniem, ulica z liczbą, litera budynku, literówka, skrócona/pełna nazwa,
kilka dopasowań i konflikt firm; niepotwierdzone adresy; rozłączenia przed i podczas
przetwarzania AI; odmowa/nieprawidłowy wynik AI; wielokrotne webhooki potwierdzenia;
SMS, przekierowania i błąd SMSAPI; długi Telegram; healthcheck.

Wynik uruchomienia: **37 testów, 37 zaliczonych, 0 błędów, 0 pominiętych**.
Sprawdzono również składnię modułów (`node --check`) i `git diff --check`.
Parser wczytał 952 adresy z aktualnego `main`; pominięto wyłącznie nagłówek „ŚDSM”.

Testy atrap sprawdzają zachowanie aplikacji i wysyłane parametry. Nie dowodzą
jakości rzeczywistej transkrypcji, głosu ani tłumaczenia modelu. Nie wykonano
prawdziwych połączeń, wywołań OpenAI ani testowych wysyłek Telegram/SMS.

## Railway — po przeglądzie zmiany

Sprawdzony stan 26 listopada 2026: projekt `content-nature`, środowisko
`production`, usługa `pogotowie`, źródło `chpogotowie/pogotowie@main`,
region `us-west2`, jedna replika, ostatni deployment ma status `SUCCESS`.
Nie zmieniono usługi, zmiennych ani deploymentu; nie ma oczekujących zmian konfiguracji.

1. Sprawdź PR i po akceptacji połącz go do `main` repozytorium
   `chpogotowie/pogotowie`. Połączenie PR może uruchomić istniejący autodeploy;
   wcześniej ustal okno wdrożenia bez aktywnych połączeń.
2. W Railway otwórz istniejącą usługę tego bota. W ustawieniach źródła sprawdź
   repozytorium `chpogotowie/pogotowie`, gałąź `main`, katalog główny `/`.
   Kod nie wymaga nowej usługi ani bazy danych.
3. Użyj Node.js >=22, komendy instalacji `npm ci` oraz Start Command `npm start`.
   Jeśli istniejąca konfiguracja uruchamia `node server.js`, nadal jest poprawna.
   Aplikacja nasłuchuje na `PORT` przekazanym przez Railway.
4. Ustaw Healthcheck Path na `/health`. Ustaw jedną replikę w jednym regionie,
   jeden proces Node; wyłącz usypianie usługi (Serverless/App Sleeping).
   Sesje są w pamięci procesu, jak w oryginale. Restart, redeploy albo rozdzielenie
   webhooków na różne repliki traci kontekst rozmowy. Wiele równoległych rozmów
   w jednej instancji jest obsługiwane osobno przez CallSid i objęte testem.
5. W Variables zachowaj dotychczasowe wartości:
   `OPENAI_API_KEY`, `TELEGRAM_BOT_TOKEN`, `TELEGRAM_CHAT_ID`,
   `TELEGRAM_THREAD_ALL`, `TELEGRAM_THREAD_WORKERS`, `SMSAPI_TOKEN`,
   `EXCLUDED_NUMBERS`, `FORWARD_TO`, `CONSULTANT_PHONE`, `DOJAZD_MINUT`.
   `BASE_URL` musi być publicznym adresem HTTPS tej konkretnej usługi,
   np. `https://pogotowie-production.up.railway.app`.
   Nie wpisuj sekretów do repozytorium. Dotychczasowe `TWILIO_SID` i
   `TWILIO_AUTH_TOKEN` mogą pozostać; ta zmiana nie wykonuje Twilio REST calls.
6. Jeśli autodeploy jest wyłączony, wdroż najnowszy commit `main` z panelu Railway.
   Sprawdź status Active i `GET https://<domena>/health` → `200 {"ok":true}`.
   Healthcheck nie wysyła wiadomości ani nie potwierdza dostępności usług zewnętrznych.
7. Sprawdź log startu i brak błędów wczytania plików adresowych. Nazwy wszystkich
   czterech plików muszą zachować wielkość liter i ścieżkę `adresy/`.

Nie dodano nowego `railway.json`: ustawienia można zastosować w istniejącej usłudze,
bez narzucania nowej konfiguracji infrastruktury.

## Twilio — wymagane ustawienia

W Console otwórz **Phone Numbers → Manage → Active numbers → numer bota**.
Jeśli numer korzysta z TwiML App zamiast bezpośrednich webhooków, zmień odpowiednie
ustawienia w tej aplikacji.

1. Voice / A call comes in: Webhook, `https://<BASE_URL>/voice`, metoda **HTTP POST**.
   Jeśli dotychczasowy URL wskazuje już tę trasę i domena się nie zmienia,
   pozostaw go.
2. **Call status changes / Status callback URL**:
   `https://<BASE_URL>/voice/status`, metoda **HTTP POST**. To nowe ustawienie jest
   konieczne, żeby zachować niepotwierdzone zgłoszenie po rozłączeniu.
   Bez callbacku działają timeouty menu, ale serwer nie dowie się o wcześniejszym
   rozłączeniu. Nie zastępuj istniejącego callbacku bez uwzględnienia jego odbiorcy;
   jeżeli jest już wykorzystywany, zapewnij przekazanie zdarzenia także do tej trasy.
3. Messaging / A message comes in: dotychczasowy `https://<BASE_URL>/sms`, **POST**.
4. Nie potrzeba Media Streams, Realtime ani ConversationRelay. `Gather` otrzymuje
   `language=pl-PL` albo `en-US`, `speechTimeout=2`, poprawne `action` i
   `actionOnEmptyResult=true`. Głosy: `Polly.Ewa` i `Polly.Joanna`.
   Początkowe menu językowe zawiera oba języki; dalsze komunikaty wyłącznie wybrany.
5. Po wdrożeniu rzeczywisty test rozmowy i dostarczania do Telegrama wymaga
   osobnego uzgodnienia. W tej zmianie takich testów nie wykonano.

## Ograniczenia operacyjne i cofnięcie

Powiadomienia są wysyłane asynchronicznie. Zachowano istniejący model bez trwałej
kolejki i trwałego magazynu sesji. Nie ma gwarancji dostarczenia przy restarcie
procesu lub awarii wszystkich usług; błędy są zapisywane bez URL-i z tokenami.
Idempotencja potwierdzeń działa w obrębie aktualnego procesu i sesji (24 godziny).
Połączenia przez konsultanta mogą odbywać się w języku używanym przez człowieka.

W razie problemów wróć w Railway do poprzedniego działającego deploymentu
(lub cofnij commit zmiany na `main` i wdroż). Przy powrocie do starego kodu usuń
callback `/voice/status`, którego stara wersja nie obsługuje, lub przywróć poprzedni.
Nie zmieniaj list adresowych w ramach rollbacku.

## Dokumentacja sprawdzona 26 listopada 2026

- [Twilio Gather: DTMF, język, hints, speechTimeout, actionOnEmptyResult](https://www.twilio.com/docs/voice/twiml/gather)
- [Twilio Say i dobór głosu](https://www.twilio.com/docs/voice/twiml/say/text-speech)
- [Twilio: zamiana Alice na Polly.Ewa dla pl-PL](https://www.twilio.com/en-us/changelog/end-support-alice-text-to-speech-voice-2023)
- [Twilio Voice Webhooks i callback końca rozmowy](https://www.twilio.com/docs/usage/webhooks/voice-webhooks)
- [OpenAI Structured Outputs; wsparcie gpt-4o-mini i json_schema](https://developers.openai.com/api/docs/guides/structured-outputs?api-mode=chat)
- [Railway Start Command](https://docs.railway.com/deployments/start-command)
- [Railway Healthchecks](https://docs.railway.com/deployments/healthchecks)
