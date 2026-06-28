require('dotenv').config();
const express = require('express');
const fs = require('fs');
const path = require('path');

const { extractReports, extractReportsFromImage } = require('./lib/anthropic');
const { generateReportPdfBuffer } = require('./lib/pdf');
const { sendText, uploadMedia, sendDocument, downloadMedia } = require('./lib/whatsapp');
const { transcribeAudio } = require('./lib/transcribe');

const app = express();
app.use(express.json());

const PORT = process.env.PORT || 3000;
const VERIFY_TOKEN = process.env.WHATSAPP_VERIFY_TOKEN || 'changeme';
const CHEF_NUMBER = (process.env.CHEF_NUMBER || '').replace(/[^0-9]/g, '');

const company = {
  firma: process.env.COMPANY_NAME || 'G-Therm Haustechnik',
  adresse: process.env.COMPANY_ADDRESS || '',
  telefon: process.env.COMPANY_PHONE || '',
  email: process.env.COMPANY_EMAIL || '',
  inhaber: process.env.COMPANY_OWNER || 'Musa Güldes'
};

const REPORTS_DIR = path.join(__dirname, 'reports');
if (!fs.existsSync(REPORTS_DIR)) fs.mkdirSync(REPORTS_DIR);

const HILFE_TEXT =
  'G-Therm Bot – das kann ich:\n\n' +
  '📝 Tagesbericht: Schick mir einfach als Text oder Sprachnachricht, was du gemacht hast ' +
  '(Kunde/Baustelle, Arbeiten, Stunden, Material). Ich erstelle daraus eine fertige PDF.\n\n' +
  '🎤 Sprachnachricht: Funktioniert auf Deutsch, Türkisch und Albanisch.\n\n' +
  '📷 Foto: Schick ein Foto von einer handschriftlichen Notiz – ich lese sie aus und mache ' +
  'einen Tagesbericht oder eine Materialliste daraus. Schreib "Material" dazu, wenn es eine Liste ist.\n\n' +
  'Schreib jederzeit "Hilfe" für diese Übersicht.';

async function forwardToChef(from, mediaId, filename, report) {
  if (!CHEF_NUMBER) return;
  if (from === CHEF_NUMBER) return;
  try {
    const info =
      'Neuer Bericht von ' + from + '\n' +
      'Kunde: ' + (report.kunde || '-') + '\n' +
      'Datum: ' + (report.datum || '-');
    await sendText(CHEF_NUMBER, info);
    await sendDocument(CHEF_NUMBER, mediaId, filename, (report.kunde || '') + ' – ' + (report.datum || ''));
  } catch (err) {
    console.error('Chef-Weiterleitung fehlgeschlagen:', err);
  }
}

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
    await forwardToChef(from, mediaId, filename, report);
  }
}

async function buildAndSendFromImage(from, buffer, mimeType, caption) {
  await sendText(from, '🔎 Notiz wird gelesen …');
  let reports;
  try {
    reports = await extractReportsFromImage(buffer, mimeType, caption);
  } catch (err) {
    console.error('Fehler beim Lesen des Fotos:', err);
    await sendText(from, '⚠️ Ich konnte die Notiz auf dem Foto nicht sicher lesen. Bitte schick ein schaerferes Foto oder den Text als Nachricht.');
    return;
  }
  if (!reports || !reports.length) {
    await sendText(from, '⚠️ Auf dem Foto war kein Bericht erkennbar. Bitte schick ein schaerferes Foto.');
    return;
  }
  await sendText(from, '📝 Bericht wird erstellt …');
  for (let i = 0; i < reports.length; i++) {
    const report = reports[i];
    if (i === 0) report.fotos = [buffer];
    const pdfBuffer = await generateReportPdfBuffer(report, company);
    const filename = `Tagesbericht_${safeName(report.kunde)}_${(report.datum || '').replace(/\./g, '-')}.pdf`;
    fs.writeFileSync(path.join(REPORTS_DIR, filename), pdfBuffer);
    const mediaId = await uploadMedia(pdfBuffer, filename, 'application/pdf');
    await sendDocument(from, mediaId, filename, `${report.kunde || ''} – ${report.datum || ''}`.trim());
    await forwardToChef(from, mediaId, filename, report);
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
        const body = (msg.text.body || '').trim();
        if (/^(hilfe|help|menu|men[üu]|start|\?)$/i.test(body)) {
          await sendText(from, HILFE_TEXT);
          continue;
        }
        const fotos = takePhotos(from);
        await buildAndSendReports(from, body, fotos);
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
        const { buffer, mimeType } = await downloadMedia(msg.image.id);
        const caption = msg.image.caption && msg.image.caption.trim();
        await buildAndSendFromImage(from, buffer, mimeType, caption);
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
