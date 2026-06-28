require('dotenv').config();
const express = require('express');
const fs = require('fs');
const path = require('path');

const { extractReports } = require('./lib/anthropic');
const { generateReportPdfBuffer } = require('./lib/pdf');
const { sendText, uploadMedia, sendDocument, downloadMedia } = require('./lib/whatsapp');

const app = express();
app.use(express.json());

const PORT = process.env.PORT || 3000;
const VERIFY_TOKEN = process.env.WHATSAPP_VERIFY_TOKEN || 'changeme';

const company = {
  firma: process.env.COMPANY_NAME || 'G-Therm Haustechnik',
  adresse: process.env.COMPANY_ADDRESS || '',
  telefon: process.env.COMPANY_PHONE || '',
  email: process.env.COMPANY_EMAIL || '',
  inhaber: process.env.COMPANY_OWNER || 'Musa Güldes'
};

const REPORTS_DIR = path.join(__dirname, 'reports');
if (!fs.existsSync(REPORTS_DIR)) fs.mkdirSync(REPORTS_DIR);

// ---------------------------------------------------------------
// Session-Verwaltung (in-memory, wird bei Server-Neustart geleert)
// Schlüssel: WhatsApp-Nummer (from)
// ---------------------------------------------------------------
const SESSION_TIMEOUT_MS = 30 * 60 * 1000; // 30 Minuten
const sessions = new Map();

function getSession(from) {
  return sessions.get(from) || null;
}

function createSession(from) {
  const session = {
    status: 'collecting', // 'collecting' | 'done'
    photos: [],           // [{ base64, mimeType }]
    text: '',             // Begleittext des Monteurs
    timer: null
  };
  resetSessionTimer(from, session);
  sessions.set(from, session);
  return session;
}

function resetSessionTimer(from, session) {
  if (session.timer) clearTimeout(session.timer);
  session.timer = setTimeout(() => {
    sessions.delete(from);
    console.log(`Session fuer ${from} abgelaufen und geloescht.`);
  }, SESSION_TIMEOUT_MS);
}

function clearSession(from) {
  const s = sessions.get(from);
  if (s && s.timer) clearTimeout(s.timer);
  sessions.delete(from);
}

// ---------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------
function safeName(s) {
  return (s || 'Bericht').replace(/[^a-zA-Z0-9äöüÄÖÜß_\- ]/g, '').trim().replace(/\s+/g, '_') || 'Bericht';
}

const FERTIG_KEYWORDS = ['fertig', 'ok', 'ja', 'done', 'go', 'weiter', 'erstellen', 'bericht'];

function isFertigText(text) {
  if (!text) return false;
  return FERTIG_KEYWORDS.some(k => text.toLowerCase().trim().startsWith(k));
}

// ---------------------------------------------------------------
// Webhook-Verifizierung
// ---------------------------------------------------------------
app.get('/webhook', (req, res) => {
  const mode = req.query['hub.mode'];
  const token = req.query['hub.verify_token'];
  const challenge = req.query['hub.challenge'];
  if (mode === 'subscribe' && token === VERIFY_TOKEN) return res.status(200).send(challenge);
  return res.sendStatus(403);
});

// ---------------------------------------------------------------
// Eingehende Nachrichten
// ---------------------------------------------------------------
app.post('/webhook', (req, res) => {
  res.sendStatus(200);
  handleIncoming(req.body).catch(err => console.error('Fehler:', err));
});

async function handleIncoming(body) {
  const entry = body && body.entry && body.entry[0];
  const change = entry && entry.changes && entry.changes[0];
  const value = change && change.value;
  const messages = value && value.messages;
  if (!messages || !messages.length) return;

  for (const msg of messages) {
    const from = msg.from;
    try {
      await handleMessage(from, msg);
    } catch (err) {
      console.error(`Fehler bei Nachricht von ${from}:`, err);
      await sendText(from, '⚠️ Fehler bei der Verarbeitung. Bitte erneut versuchen.').catch(() => {});
    }
  }
}

async function handleMessage(from, msg) {
  const type = msg.type;
  const session = getSession(from);

  // ---- FOTO empfangen ----
  if (type === 'image') {
    const mediaId = msg.image.id;
    const caption = msg.image.caption || '';

    // Foto herunterladen
    const imgData = await downloadMedia(mediaId);

    if (!session) {
      // Neue Session starten
      const s = createSession(from);
      s.photos.push(imgData);
      if (caption) s.text = caption;

      await sendText(from,
        `📸 Foto ${s.photos.length} erhalten.\n\n` +
        `Gehören noch weitere Fotos dazu? Falls ja, schick sie einfach weiter.\n\n` +
        `Wenn du fertig bist:\n` +
        `• Schreib eine kurze Beschreibung (Baustelle, Arbeiten, Uhrzeit)\n` +
        `• Oder schreib einfach *fertig* um den Bericht zu erstellen`
      );
    } else {
      // Weitere Fotos zur bestehenden Session hinzufügen
      session.photos.push(imgData);
      if (caption) session.text += (session.text ? '\n' : '') + caption;
      resetSessionTimer(from, session);

      await sendText(from,
        `📸 Foto ${session.photos.length} hinzugefügt.\n\n` +
        `Noch mehr Fotos? Oder Beschreibung/Text schicken um den Bericht zu erstellen.`
      );
    }
    return;
  }

  // ---- SPRACHNOTIZ empfangen ----
  if (type === 'audio') {
    if (!session) {
      await sendText(from,
        '🎤 Sprachnotizen kann ich leider noch nicht automatisch transkribieren.\n\n' +
        'Bitte schreib die wichtigsten Infos als Text:\n' +
        '• Baustelle / Kunde\n' +
        '• Was wurde gemacht?\n' +
        '• Arbeitszeit\n' +
        '• Verwendetes Material'
      );
    } else {
      // Es gibt eine aktive Session mit Fotos – Text anfordern
      await sendText(from,
        '🎤 Sprachnotizen kann ich noch nicht verarbeiten.\n\n' +
        `Du hast bereits ${session.photos.length} Foto(s) gesendet.\n` +
        'Schreib die Beschreibung kurz als Text, dann erstelle ich den Bericht.'
      );
    }
    return;
  }

  // ---- TEXT empfangen ----
  if (type === 'text') {
    const rawText = msg.text.body;

    if (!session) {
      // Kein laufender Sammelvorgang → direkt als reinen Textbericht verarbeiten
      await sendText(from, '🔍 Notiz wird gelesen …');
      await sendText(from, '📝 Bericht wird erstellt …');
      await createAndSendReports(from, rawText, []);
      return;
    }

    // Es gibt eine aktive Session mit Fotos
    if (isFertigText(rawText) && !session.text) {
      // Nur "fertig" ohne vorherigen Beschreibungstext → kurz nachfragen
      await sendText(from,
        `Du hast ${session.photos.length} Foto(s) gesendet.\n\n` +
        'Magst du noch kurz dazuschreiben:\n' +
        '• Baustelle / Kunde?\n' +
        '• Was wurde gemacht?\n' +
        '• Uhrzeit?\n\n' +
        'Oder schreib nochmal *fertig* um den Bericht nur mit den Fotos zu erstellen.'
      );
      session.text = '__nachgefragt__';
      resetSessionTimer(from, session);
      return;
    }

    // Text zur Session hinzufügen (oder zweites "fertig" ohne Text)
    if (rawText.toLowerCase().trim() !== 'fertig' || session.text !== '__nachgefragt__') {
      session.text = (session.text === '__nachgefragt__' ? '' : session.text + (session.text ? '\n' : '')) + rawText;
    }

    resetSessionTimer(from, session);
    const photos = session.photos;
    const combinedText = session.text === '__nachgefragt__' ? '' : session.text;
    clearSession(from);

    await sendText(from, `🔍 ${photos.length} Foto(s) + Text werden ausgewertet …`);
    await sendText(from, '📝 Bericht wird erstellt …');
    await createAndSendReports(from, combinedText, photos);
    return;
  }

  // ---- Sonstiger Nachrichtentyp ----
  await sendText(from,
    'Ich kann aktuell Text und Fotos verarbeiten. Sprachnotizen bitte als Text schicken.'
  );
}

async function createAndSendReports(from, text, images) {
  try {
    const reports = await extractReports(text, images);
    for (const report of reports) {
      const pdfBuffer = await generateReportPdfBuffer(report, company);
      const filename = `Tagesbericht_${safeName(report.kunde)}_${(report.datum || '').replace(/\./g, '-')}.pdf`;
      fs.writeFileSync(path.join(REPORTS_DIR, filename), pdfBuffer);
      const mediaId = await uploadMedia(pdfBuffer, filename, 'application/pdf');
      await sendDocument(from, mediaId, filename, `${report.kunde || ''} – ${report.datum || ''}`.trim());
    }
  } catch (err) {
    console.error('Fehler bei Berichtserstellung:', err);
    await sendText(from, '⚠️ Bericht konnte nicht erstellt werden. Bitte erneut versuchen.').catch(() => {});
  }
}

app.get('/health', (req, res) => res.json({ ok: true }));

if (require.main === module) {
  app.listen(PORT, () => console.log(`Server läuft auf Port ${PORT}`));
}

module.exports = app;
