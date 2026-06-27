require('dotenv').config();
const express = require('express');
const fs = require('fs');
const path = require('path');

const { extractReports } = require('./lib/anthropic');
const { generateReportPdfBuffer } = require('./lib/pdf');
const { sendText, uploadMedia, sendDocument, downloadMedia } = require('./lib/whatsapp');
const { transcribeAudio } = require('./lib/transcribe');

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

// Zwischenspeicher fuer Fotos ohne Begleittext (pro Absender).
const pendingPhotos = {};
const PHOTO_TTL_MS = 10 * 60 * 1000;

function safeName(s) {
  return (s || 'Bericht').replace(/[^a-zA-Z0-9äöüÄÖÜß_\- ]/g, '').trim().replace(/\s+/g, '_') || 'Bericht';
}

function stashPhoto(from, buffer) {
  if (!pendingPhotos[from]) pendingPhotos[from] = { fotos: [], timer: null };
  pendingPhotos[from].fotos.push(buffer);
  if (pendingPhotos[from].timer) clearTimeout(pendingPhotos[from].timer);
  pendingPhotos[from].timer = setTimeout(() => {
    delete pendingPhotos[from];
  }, PHOTO_TTL_MS);
}

function takePhotos(from) {
  const entry = pendingPhotos[from];
  if (!entry) return [];
  if (entry.timer) clearTimeout(entry.timer);
  delete pendingPhotos[from];
  return entry.fotos;
}

// --- Meta Webhook-Verifizierung ---
app.get('/webhook', (req, res) => {
  const mode = req.query['hub.mode'];
  const token = req.query['hub.verify_token'];
  const challenge = req.query['hub.challenge'];
  if (mode === 'subscribe' && token === VERIFY_TOKEN) {
    return res.status(200).send(challenge);
  }
  return res.sendStatus(403);
});

// --- Eingehende WhatsApp-Nachrichten ---
app.post('/webhook', (req, res) => {
  res.sendStatus(200);
  handleIncoming(req.body).catch((err) => {
    console.error('Fehler bei der Verarbeitung einer Nachricht:', err);
  });
});

async function buildAndSendReports(from, rawText, fotos) {
  await sendText(from, '📝 Bericht wird erstellt …');
  const reports = await extractReports(rawText);

  for (let i = 0; i < reports.length; i++) {
    const report = reports[i];
    if (i === 0 && fotos && fotos.length) report.fotos = fotos;

    const pdfBuffer = await generateReportPdfBuffer(report, company);
    const filename = `Tagesbericht_${safeName(report.kunde)}_${(report.datum || '').replace(/\./g, '-')}.pdf`;
    fs.writeFileSync(path.join(REPORTS_DIR, filename), pdfBuffer);

    const mediaId = await uploadMedia(pdfBuffer, filename, 'application/pdf');
    await sendDocument(from, mediaId, filename, `${report.kunde || ''} – ${report.datum || ''}`.trim());
  }
}

async function handleIncoming(body) {
  const entry = body && body.entry && body.entry[0];
  const change = entry && entry.changes && entry.changes[0];
  const value = change && change.value;
  const messages = value && value.messages;
  if (!messages || !messages.length) return;

  for (const msg of messages) {
    const from = msg.from;

    try {
      if (msg.type === 'text') {
        const fotos = takePhotos(from);
        await buildAndSendReports(from, msg.text.body, fotos);
        continue;
      }

      if (msg.type === 'audio' || msg.type === 'voice') {
        const media = msg.audio || msg.voice;
        await sendText(from, '🎙️ Sprachnachricht wird ausgewertet …');
        const { buffer, mimeType } = await downloadMedia(media.id);
        const text = await transcribeAudio(buffer, mimeType);
        if (!text) {
          await sendText(from, '⚠️ Die Sprachnachricht konnte nicht verstanden werden. Bitte erneut aufnehmen.');
          continue;
        }
        const fotos = takePhotos(from);
        await buildAndSendReports(from, text, fotos);
        continue;
      }

      if (msg.type === 'image') {
        const { buffer } = await downloadMedia(msg.image.id);
        const caption = msg.image.caption && msg.image.caption.trim();
        if (caption) {
          await buildAndSendReports(from, caption, [buffer]);
        } else {
          stashPhoto(from, buffer);
          await sendText(from, '📷 Foto gespeichert. Schick mir jetzt den Bericht als Text oder Sprachnachricht, dann haenge ich das Foto an.');
        }
        continue;
      }

      await sendText(
        from,
        'Ich verarbeite Text, Sprachnachrichten und Fotos. Bitte schick den Tagesbericht als Text oder Sprachnachricht (Fotos optional).'
      );
    } catch (err) {
      console.error('Fehler bei Berichtserstellung:', err);
      await sendText(
        from,
        '⚠️ Der Bericht konnte nicht automatisch erstellt werden. Bitte erneut versuchen.'
      ).catch((e) => console.error(e));
    }
  }
}

app.get('/health', (req, res) => res.json({ ok: true }));

if (require.main === module) {
  app.listen(PORT, () => console.log(`Server läuft auf Port ${PORT}`));
}

module.exports = app;
