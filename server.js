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
// Whisper-Transkription (OpenAI)
// ---------------------------------------------------------------
async function transcribeAudio(audioBuffer, mimeType) {
  const apiKey = process.env.OPENAI_API_KEY;
  if (!apiKey) throw new Error('OPENAI_API_KEY nicht gesetzt');

  // WhatsApp liefert meist audio/ogg oder audio/mpeg
  const ext = mimeType.includes('ogg') ? 'ogg' : mimeType.includes('mpeg') ? 'mp3' : 'ogg';
  const filename = `voice.${ext}`;

  const form = new FormData();
  form.append('file', new Blob([audioBuffer], { type: mimeType }), filename);
  form.append('model', 'whisper-1');
  form.append('language', 'de');

  const resp = await fetch('https://api.openai.com/v1/audio/transcriptions', {
    method: 'POST',
    headers: { Authorization: `Bearer ${apiKey}` },
    body: form
  });

  if (!resp.ok) {
    const err = await resp.text();
    throw new Error(`Whisper Fehler ${resp.status}: ${err}`);
  }
  const data = await resp.json();
  return data.text || '';
}

// ---------------------------------------------------------------
// Session-Verwaltung
// ---------------------------------------------------------------
const SESSION_TIMEOUT_MS = 30 * 60 * 1000;
const sessions = new Map();

function getSession(from) { return sessions.get(from) || null; }

function createSession(from) {
  const session = { status: 'collecting', photos: [], text: '', timer: null };
  resetSessionTimer(from, session);
  sessions.set(from, session);
  return session;
}

function resetSessionTimer(from, session) {
  if (session.timer) clearTimeout(session.timer);
  session.timer = setTimeout(() => {
    sessions.delete(from);
    console.log(`Session ${from} abgelaufen.`);
  }, SESSION_TIMEOUT_MS);
}

function clearSession(from) {
  const s = sessions.get(from);
  if (s && s.timer) clearTimeout(s.timer);
  sessions.delete(from);
}

function safeName(s) {
  return (s || 'Bericht').replace(/[^a-zA-Z0-9äöüÄÖÜß_\- ]/g, '').trim().replace(/\s+/g, '_') || 'Bericht';
}

const FERTIG_KEYWORDS = ['fertig', 'ok', 'ja', 'done', 'go', 'weiter', 'erstellen', 'bericht'];
function isFertig(text) {
  if (!text) return false;
  return FERTIG_KEYWORDS.some(k => text.toLowerCase().trim().startsWith(k));
}

// ---------------------------------------------------------------
// Webhook
// ---------------------------------------------------------------
app.get('/webhook', (req, res) => {
  const mode = req.query['hub.mode'];
  const token = req.query['hub.verify_token'];
  const challenge = req.query['hub.challenge'];
  if (mode === 'subscribe' && token === VERIFY_TOKEN) return res.status(200).send(challenge);
  return res.sendStatus(403);
});

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
    try { await handleMessage(from, msg); }
    catch (err) {
      console.error(`Fehler bei ${from}:`, err);
      await sendText(from, '⚠️ Fehler bei der Verarbeitung. Bitte erneut versuchen.').catch(() => {});
    }
  }
}

async function handleMessage(from, msg) {
  const type = msg.type;
  const session = getSession(from);

  // ---- FOTO ----
  if (type === 'image') {
    const imgData = await downloadMedia(msg.image.id);
    const caption = msg.image.caption || '';

    if (!session) {
      const s = createSession(from);
      s.photos.push(imgData);
      if (caption) s.text = caption;
      await sendText(from,
        `📸 Foto ${s.photos.length} erhalten.\n\n` +
        `Noch mehr Fotos? Schick sie einfach weiter.\n\n` +
        `Wenn fertig: kurze Beschreibung schicken (Baustelle, Arbeiten, Uhrzeit) oder *fertig* tippen.`
      );
    } else {
      session.photos.push(imgData);
      if (caption) session.text += (session.text ? '\n' : '') + caption;
      resetSessionTimer(from, session);
      await sendText(from,
        `📸 Foto ${session.photos.length} hinzugefügt.\n\nNoch mehr? Oder Beschreibung / Text schicken.`
      );
    }
    return;
  }

  // ---- SPRACHNOTIZ ----
  if (type === 'audio') {
    await sendText(from, '🎤 Sprachnotiz wird transkribiert …');
    try {
      const { base64, mimeType } = await downloadMedia(msg.audio.id);
      const audioBuffer = Buffer.from(base64, 'base64');
      const transcript = await transcribeAudio(audioBuffer, mimeType);

      if (!transcript || transcript.trim().length < 3) {
        await sendText(from, '⚠️ Sprachnotiz konnte nicht erkannt werden. Bitte nochmal sprechen oder als Text schicken.');
        return;
      }

      console.log(`Transkription von ${from}: ${transcript}`);

      if (!session) {
        // Sprachnotiz alleine → direkt Bericht erstellen
        await sendText(from, `📝 Erkannt: "${transcript}"\n\nBericht wird erstellt …`);
        await createAndSendReports(from, transcript, []);
      } else {
        // Es gibt eine aktive Foto-Session → Transkript als Text hinzufügen
        session.text += (session.text ? '\n' : '') + transcript;
        resetSessionTimer(from, session);
        const photos = session.photos;
        const combinedText = session.text;
        clearSession(from);
        await sendText(from, `📝 Erkannt: "${transcript}"\n\n🔍 ${photos.length} Foto(s) + Sprachnotiz werden ausgewertet …`);
        await sendText(from, '📝 Bericht wird erstellt …');
        await createAndSendReports(from, combinedText, photos);
      }
    } catch (err) {
      console.error('Whisper Fehler:', err);
      await sendText(from, '⚠️ Transkription fehlgeschlagen. Bitte als Text schicken.');
    }
    return;
  }

  // ---- TEXT ----
  if (type === 'text') {
    const rawText = msg.text.body;

    if (!session) {
      // Reiner Textbericht
      await sendText(from, '🔍 Notiz wird gelesen …');
      await sendText(from, '📝 Bericht wird erstellt …');
      await createAndSendReports(from, rawText, []);
      return;
    }

    // Aktive Foto-Session
    if (isFertig(rawText) && !session.text) {
      // Erstes "fertig" ohne Text → kurz nachfragen
      await sendText(from,
        `Du hast ${session.photos.length} Foto(s) gesendet.\n\n` +
        'Magst du noch kurz ergänzen:\n• Baustelle / Kunde?\n• Was wurde gemacht?\n• Uhrzeit?\n\n' +
        'Oder schick nochmal *fertig* für Bericht nur mit Fotos.'
      );
      session.text = '__nachgefragt__';
      resetSessionTimer(from, session);
      return;
    }

    if (rawText.toLowerCase().trim() !== 'fertig' || session.text !== '__nachgefragt__') {
      session.text = (session.text === '__nachgefragt__' ? '' : (session.text ? session.text + '\n' : '')) + rawText;
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

  // ---- Sonstiges ----
  await sendText(from, 'Ich kann Text, Fotos und Sprachnotizen verarbeiten.');
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
    console.error('Bericht-Fehler:', err);
    await sendText(from, '⚠️ Bericht konnte nicht erstellt werden. Bitte erneut versuchen.').catch(() => {});
  }
}

app.get('/health', (req, res) => res.json({ ok: true }));

if (require.main === module) {
  app.listen(PORT, () => console.log(`Server läuft auf Port ${PORT}`));
}

module.exports = app;
