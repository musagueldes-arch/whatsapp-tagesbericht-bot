require('dotenv').config();
const express = require('express');
const fs = require('fs');
const path = require('path');

const { extractReports } = require('./lib/anthropic');
const { generateReportPdfBuffer } = require('./lib/pdf');
const { sendText, uploadMedia, sendDocument } = require('./lib/whatsapp');

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

function safeName(s) {
  return (s || 'Bericht').replace(/[^a-zA-Z0-9äöüÄÖÜß_\- ]/g, '').trim().replace(/\s+/g, '_') || 'Bericht';
}

// --- Meta Webhook-Verifizierung (einmalig beim Einrichten) ---
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
  // Meta erwartet eine sofortige Antwort, Verarbeitung laeuft danach asynchron
  res.sendStatus(200);
  handleIncoming(req.body).catch((err) => {
    console.error('Fehler bei der Verarbeitung einer Nachricht:', err);
  });
});

async function handleIncoming(body) {
  const entry = body && body.entry && body.entry[0];
  const change = entry && entry.changes && entry.changes[0];
  const value = change && change.value;
  const messages = value && value.messages;
  if (!messages || !messages.length) return; // z.B. Status-Updates ohne eigentliche Nachricht

  for (const msg of messages) {
    const from = msg.from;

    if (msg.type !== 'text') {
      await sendText(
        from,
        'Aktuell verarbeite ich nur Text-Nachrichten. Bitte den Tagesbericht als Text schicken.'
      ).catch((e) => console.error(e));
      continue;
    }

    const rawText = msg.text.body;

    try {
      await sendText(from, '📝 Bericht wird erstellt …');
      const reports = await extractReports(rawText);

      for (const report of reports) {
        const pdfBuffer = await generateReportPdfBuffer(report, company);
        const filename = `Tagesbericht_${safeName(report.kunde)}_${(report.datum || '').replace(/\./g, '-')}.pdf`;
        fs.writeFileSync(path.join(REPORTS_DIR, filename), pdfBuffer);

        const mediaId = await uploadMedia(pdfBuffer, filename, 'application/pdf');
        await sendDocument(from, mediaId, filename, `${report.kunde || ''} – ${report.datum || ''}`.trim());
      }
    } catch (err) {
      console.error('Fehler bei Berichtserstellung:', err);
      await sendText(
        from,
        '⚠️ Der Bericht konnte nicht automatisch erstellt werden. Bitte Text pruefen und erneut senden.'
      ).catch((e) => console.error(e));
    }
  }
}

app.get('/health', (req, res) => res.json({ ok: true }));

if (require.main === module) {
  app.listen(PORT, () => console.log(`Server läuft auf Port ${PORT}`));
}

module.exports = app;
