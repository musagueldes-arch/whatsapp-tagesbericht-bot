# WhatsApp Tagesbericht Bot

Monteur schickt eine WhatsApp-Textnachricht an die Firmennummer → eine KI strukturiert
sie automatisch → wenige Sekunden später kommt ein fertiges PDF als WhatsApp-Dokument
zurück. Kein Copy-Paste mehr nötig.

Getestet: JSON-Erkennung der KI-Antwort (inkl. Markdown-Codefences), PDF-Erzeugung,
Webhook-Verifizierung, Verarbeitung von Status-Updates ohne Absturz. **Nicht** mit
einer echten WhatsApp-Nummer getestet — das kann nur mit einem echten Meta-Account
geprüft werden (siehe unten).

## Was du selbst einrichten musst

Das hier kann ich nicht für dich übernehmen, weil es deine Firmenidentität, eigene
Zugangsdaten und eine laufende Rechnung betrifft:

1. **Meta Business Manager** (business.facebook.com) – Unternehmen mit deinen
   G-Therm-Firmendaten anlegen/verifizieren lassen (dauert 2 Tage bis 4 Wochen).
2. **Meta for Developers** (developers.facebook.com) – eine App vom Typ „Business“
   anlegen, das Produkt „WhatsApp“ hinzufügen.
3. Eine **eigene Telefonnummer** für die WhatsApp Business API hinterlegen – nicht
   deine private WhatsApp-Nummer. Eine zusätzliche SIM oder eine VoIP-Nummer reicht.
4. Im WhatsApp-Produkt ein **dauerhaftes System-User-Token** erzeugen (nicht das
   24-Stunden-Test-Token), mit den Rechten `whatsapp_business_messaging` und
   `whatsapp_business_management`.
5. Einen **Anthropic API Key** unter console.anthropic.com anlegen (eigenes Konto,
   eigene Abrechnung – nicht dasselbe wie ein claude.ai-Zugang).
6. Einen **Server, der 24/7 läuft und von außen per HTTPS erreichbar ist** (Meta ruft
   den Webhook von außen auf, localhost reicht nicht). Günstige Optionen: Railway,
   Render, Hetzner – ab ca. 5 €/Monat.

## Einrichtung

```bash
npm install
cp .env.example .env
# .env mit deinen Werten aus Schritt 1-5 oben ausfüllen
npm start
```

Danach in Meta for Developers unter WhatsApp → Konfiguration:
- **Callback-URL:** `https://DEINE-DOMAIN/webhook`
- **Verify Token:** der Wert, den du bei `WHATSAPP_VERIFY_TOKEN` in der `.env` eingetragen hast
- Webhook-Feld **`messages`** abonnieren

## Lokal testen, bevor du live gehst

```bash
npm start
# in einem zweiten Terminal:
curl "http://localhost:3000/webhook?hub.mode=subscribe&hub.verify_token=DEINTOKEN&hub.challenge=test123"
# sollte "test123" zurückgeben
curl http://localhost:3000/health
# sollte {"ok":true} zurückgeben
```

## Wie es funktioniert

1. Monteur schreibt eine Textnachricht an die Business-Nummer.
2. `server.js` empfängt sie über `/webhook`, antwortet Meta sofort mit 200 (Pflicht),
   verarbeitet die Nachricht danach im Hintergrund.
3. `lib/anthropic.js` schickt den Text an die Anthropic API und bekommt strukturierte
   Felder zurück (Datum, Kunde, Arbeiten, Material, …). Bei mehreren Baustellen/Tagen
   in einer Nachricht werden automatisch mehrere Berichte erzeugt.
4. `lib/pdf.js` baut daraus ein PDF im G-Therm-Layout.
5. `lib/whatsapp.js` lädt das PDF zu Meta hoch und schickt es als Dokument an den
   Absender zurück.
6. Jeder Bericht wird zusätzlich lokal im Ordner `reports/` abgelegt.

## Grenzen dieser ersten Version

- **Nur Text-Nachrichten** – Sprachnachrichten und Fotos werden aktuell mit einem
  Hinweistext beantwortet, aber nicht verarbeitet. Lässt sich nachrüsten (Transkription
  per Whisper/Anthropic, Foto-Analyse), war aber nicht Teil der Anforderung.
- **Keine Datenbank** – Berichte liegen nur als PDF-Dateien im Ordner `reports/` auf
  dem Server. Für echten Produktivbetrieb würde ich das auf Google Drive oder eine
  kleine Datenbank umstellen, damit nichts verloren geht, wenn der Server neu startet.
- **max_tokens 1000** bei der KI-Anfrage – bei sehr vielen Baustellen in einer einzigen
  Nachricht kann die Antwort abgeschnitten werden. Für den normalen Tagesgebrauch
  (1-3 Baustellen pro Nachricht) reicht das.
- Briefkopf-Daten (Adresse etc.) stehen aktuell fest in der `.env` – keine
  Mehrfirmen-Unterstützung.

## Kosten zur Einordnung

- **Meta:** Da die Monteure zuerst schreiben (nicht du sie anschreibst), zählt das als
  kostenlose „Service-Conversation“ – keine Meta-Gebühren für diesen Anwendungsfall.
- **Anthropic API:** wenige Cent pro Bericht.
- **Hosting:** ab ca. 5 €/Monat.
- **Zeitaufwand Einrichtung:** realistisch 2-4 Stunden, der größte Teil davon ist die
  Wartezeit auf die Meta-Geschäftsverifizierung.
