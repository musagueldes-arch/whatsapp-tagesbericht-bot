require('dotenv').config();
const express = require('express');
const fs = require('fs');
const path = require('path');

const { extractReports } = require('./lib/anthropic');
const { generateReportPdfBuffer } = require('./lib/pdf');
const { sendText, uploadMedia, sendDocument, downloadMedia } = require('./lib/whatsapp');
const { transcribeAudio, extractAudioFromVideo, extractFramesFromVideo } = require('./lib/transcribe');

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
// Whitelist – nur erlaubte Nummern dürfen den Bot nutzen
// Railway Variable: ALLOWED_NUMBERS=491234567890,491987654321,...
// ---------------------------------------------------------------
function isAllowed(from) {
  const allowed = process.env.ALLOWED_NUMBERS;
  if (!allowed || !allowed.trim()) return true; // kein Filter gesetzt → alle erlaubt
  const list = allowed.split(',').map(n => n.trim().replace(/D/g, ''));
  return list.includes(from.replace(/D/g, ''));
}


// ---------------------------------------------------------------
// Session-Status:
// idle         → keine aktive Session
// collecting   → Fotos/Videos werden gesammelt
// awaiting_desc→ warte auf Beschreibung (Text/Sprache)
// preview_text → zeige transkribierten Text, warte auf Bestätigung
// preview_report→ zeige Bericht-Entwurf, warte auf Freigabe
// ---------------------------------------------------------------
const SESSION_TIMEOUT_MS = 30 * 60 * 1000;
const sessions = new Map();

function getSession(from) { return sessions.get(from) || null; }

function createSession(from) {
  const s = {
    status: 'collecting',
    photos: [],      // { base64, mimeType }
    text: '',        // Beschreibungstext
    transcript: '',  // Whisper-Ergebnis (roh)
    language: null,  // { label, flag }
    reportDraft: null, // Array von Report-Objekten nach KI-Analyse
    timer: null
  };
  resetTimer(from, s);
  sessions.set(from, s);
  return s;
}

function resetTimer(from, s) {
  if (s.timer) clearTimeout(s.timer);
  s.timer = setTimeout(() => { sessions.delete(from); }, SESSION_TIMEOUT_MS);
}

function clearSession(from) {
  const s = sessions.get(from);
  if (s && s.timer) clearTimeout(s.timer);
  sessions.delete(from);
}

function safeName(str) {
  return (str || 'Bericht').replace(/[^a-zA-Z0-9äöüÄÖÜß_\- ]/g, '').trim().replace(/\s+/g, '_') || 'Bericht';
}

const JA_WORDS = ['ja', 'yes', 'ok', 'jo', 'gut', 'fertig', 'weiter', 'done', 'passt', 'stimmt', 'korrekt', 'alles gut', 'si', 'да', 'bəli'];
const NEIN_WORDS = ['nein', 'no', 'nicht', 'änder', 'falsch', 'korrigier', 'correc'];

function isJa(text) {
  if (!text) return false;
  const t = text.toLowerCase().trim();
  return JA_WORDS.some(w => t.startsWith(w));
}

function isNein(text) {
  if (!text) return false;
  const t = text.toLowerCase().trim();
  return NEIN_WORDS.some(w => t.includes(w));
}

// ---------------------------------------------------------------
// Webhook
// ---------------------------------------------------------------
app.get('/webhook', (req, res) => {
  if (req.query['hub.mode'] === 'subscribe' && req.query['hub.verify_token'] === VERIFY_TOKEN)
    return res.status(200).send(req.query['hub.challenge']);
  return res.sendStatus(403);
});

app.post('/webhook', (req, res) => {
  res.sendStatus(200);
  handleIncoming(req.body).catch(err => console.error('Webhook-Fehler:', err));
});

async function handleIncoming(body) {
  const messages = body?.entry?.[0]?.changes?.[0]?.value?.messages;
  if (!messages?.length) return;
  for (const msg of messages) {
    if (!isAllowed(msg.from)) {
      console.log('Abgelehnt (nicht auf Whitelist):', msg.from);
      return;
    }
    try { await handleMessage(msg.from, msg); }
    catch (err) {
      console.error(`Fehler [${msg.from}]:`, err.message);
      await sendText(msg.from, '⚠️ Fehler. Bitte erneut versuchen.').catch(() => {});
    }
  }
}

// ---------------------------------------------------------------
// Haupt-Nachrichtenverarbeitung (5-Schritte-Flow)
// ---------------------------------------------------------------
async function handleMessage(from, msg) {
  const session = getSession(from);
  const type = msg.type;

  // ============================================================
  // SCHRITT 1 – MEDIEN SAMMELN (Fotos & Videos)
  // ============================================================
  if (type === 'image') {
    const s = session || createSession(from);
    s.status = 'collecting';
    const imgData = await downloadMedia(msg.image.id);
    s.photos.push(imgData);
    if (msg.image.caption) s.text += (s.text ? '\n' : '') + msg.image.caption;
    resetTimer(from, s);

    await sendText(from,
      `📸 Foto ${s.photos.length} erhalten.\n\n` +
      `Noch mehr Fotos oder Videos? Schick sie weiter.\n\n` +
      `Wenn alle Medien vollständig sind → schreib *ja*`
    );
    return;
  }

  if (type === 'video') {
    const s = session || createSession(from);
    s.status = 'collecting';

    await sendText(from, '🎬 Video wird verarbeitet (Frames + Ton) …');

    const { base64, mimeType } = await downloadMedia(msg.video.id);
    const videoBuffer = Buffer.from(base64, 'base64');

    // Frames extrahieren
    const frames = extractFramesFromVideo(videoBuffer, mimeType, 8);
    s.photos.push(...frames);
    console.log(`Video: ${frames.length} Frames extrahiert.`);

    // Ton transkribieren
    try {
      const audioBuffer = extractAudioFromVideo(videoBuffer, mimeType);
      const { text: videoTranscript, language } = await transcribeAudio(audioBuffer, 'audio/ogg');
      if (videoTranscript) {
        s.transcript += (s.transcript ? '\n' : '') + videoTranscript;
        s.language = language;
        console.log(`Video-Ton [${language.label}]: ${videoTranscript}`);
      }
    } catch (e) {
      console.log('Kein Ton im Video oder Transkription fehlgeschlagen:', e.message);
    }

    if (msg.video.caption) s.text += (s.text ? '\n' : '') + msg.video.caption;
    resetTimer(from, s);

    const langInfo = s.language ? ` ${s.language.flag} Sprache: ${s.language.label}` : '';
    await sendText(from,
      `🎬 Video verarbeitet: ${frames.length} Frames + Ton transkribiert.${langInfo}\n\n` +
      `Noch mehr Fotos oder Videos? Schick sie weiter.\n\n` +
      `Wenn alle Medien vollständig sind → schreib *ja*`
    );
    return;
  }

  // ============================================================
  // TEXT-VERARBEITUNG – je nach aktuellem Status
  // ============================================================
  if (type === 'text') {
    const rawText = msg.text.body;

    // --- Kein laufender Flow → direkter Textbericht ---
    if (!session) {
      await sendText(from, '🔍 Notiz wird gelesen …');
      await sendText(from, '📝 Bericht wird erstellt …');
      await createAndSendReports(from, rawText, []);
      return;
    }

    resetTimer(from, session);

    // --- SCHRITT 1→2: Medien vollständig bestätigt ---
    if (session.status === 'collecting' && isJa(rawText)) {
      session.status = 'awaiting_desc';
      await sendText(from,
        `✅ Medien gespeichert (${session.photos.length} Foto(s)/Frame(s)).\n\n` +
        `Jetzt Beschreibung hinzufügen:\n` +
        `• Sprachnotiz aufnehmen\n` +
        `• Oder als Text schreiben\n\n` +
        `_(Baustelle, Arbeiten, Uhrzeit, Mitarbeiter)_`
      );
      return;
    }

    // --- Noch in "collecting" aber kein "ja" → weiter sammeln ---
    if (session.status === 'collecting') {
      session.text += (session.text ? '\n' : '') + rawText;
      await sendText(from,
        `📝 Notiz gespeichert.\n\n` +
        `Noch mehr Fotos/Videos? Oder schreib *ja* wenn alles vollständig ist.`
      );
      return;
    }

    // --- SCHRITT 2→3: Beschreibung als Text erhalten ---
    if (session.status === 'awaiting_desc') {
      session.text += (session.text ? '\n' : '') + rawText;
      session.status = 'preview_text';

      const combinedText = [session.transcript, session.text].filter(Boolean).join('\n');
      const langInfo = session.language ? ` ${session.language.flag} Erkannte Sprache: ${session.language.label}` : '';

      await sendText(from,
        `📋 Erkannter Text:${langInfo}\n\n` +
        `"${combinedText}"\n\n` +
        `Ist das korrekt?\n` +
        `• *ja* → Bericht-Entwurf erstellen\n` +
        `• Oder schreib eine Korrektur`
      );
      return;
    }

    // --- SCHRITT 3: Text-Vorschau – Korrektur oder Bestätigung ---
    if (session.status === 'preview_text') {
      if (isJa(rawText)) {
        // Weiter zu Schritt 4: Bericht-Entwurf
        await sendText(from, '🔍 Bericht-Entwurf wird erstellt …');
        const combinedText = [session.transcript, session.text].filter(Boolean).join('\n');
        const reports = await extractReports(combinedText, session.photos);
        session.reportDraft = reports;
        session.status = 'preview_report';

        // Kompakte Zusammenfassung anzeigen
        for (let i = 0; i < reports.length; i++) {
          const r = reports[i];
          const nr = reports.length > 1 ? `Bericht ${i + 1}/${reports.length}: ` : '';
          const arbeiten = r.arbeiten ? r.arbeiten.split('\n').map(l => `  • ${l}`).join('\n') : '  -';
          const material = r.material ? r.material.split('\n').slice(0, 4).map(l => `  • ${l}`).join('\n') : '  -';
          await sendText(from,
            `📋 ${nr}Entwurf:\n\n` +
            `📅 ${r.datum || '-'}  ⏱ ${r.arbeitszeit || '-'}\n` +
            `🏠 ${r.kunde || '-'}\n` +
            `👷 ${r.mitarbeiter || '-'}\n\n` +
            `Arbeiten:\n${arbeiten}\n\n` +
            `Material:\n${material}\n\n` +
            `Besonderheiten: ${r.besonderheiten || '-'}\n\n` +
            `Korrekt? *ja* → PDF erstellen\nOder schreib was geändert werden soll.`
          );
        }
        return;
      } else {
        // Korrektur am Text
        session.text = rawText;
        session.status = 'preview_text';
        const combinedText = [session.transcript, session.text].filter(Boolean).join('\n');
        const langInfo = session.language ? ` ${session.language.flag} ${session.language.label}` : '';
        await sendText(from,
          `📋 Aktualisierter Text:${langInfo}\n\n` +
          `"${combinedText}"\n\n` +
          `*ja* → weiter / Oder nochmals korrigieren`
        );
        return;
      }
    }

    // --- SCHRITT 4: Bericht-Entwurf – Freigabe oder Korrektur ---
    if (session.status === 'preview_report') {
      if (isJa(rawText)) {
        // SCHRITT 5: PDF erstellen und senden
        const reports = session.reportDraft;
        clearSession(from);
        await sendText(from, '📄 PDF wird erstellt …');
        await sendReportPdfs(from, reports);
      } else {
        // Korrektur: Text anpassen und neu auswerten
        session.text = rawText;
        session.status = 'preview_text';
        const combinedText = [session.transcript, session.text].filter(Boolean).join('\n');
        await sendText(from,
          `📋 Korrektur gespeichert:\n\n"${combinedText}"\n\n*ja* → neuen Entwurf erstellen`
        );
      }
      return;
    }
  }

  // ============================================================
  // SPRACHNOTIZ
  // ============================================================
  if (type === 'audio') {
    const s = session || null;

    await sendText(from, '🎤 Sprachnotiz wird transkribiert …');
    try {
      const { base64, mimeType } = await downloadMedia(msg.audio.id);
      const audioBuffer = Buffer.from(base64, 'base64');
      const { text: transcript, language } = await transcribeAudio(audioBuffer, mimeType);

      console.log(`Transkript [${from}] ${language.flag}: ${transcript}`);

      if (!s) {
        // Sprachnotiz alleine → direkt Bericht (Schritt 3 überspringen, direkt Entwurf)
        const newSession = createSession(from);
        newSession.transcript = transcript;
        newSession.language = language;
        newSession.status = 'preview_text';

        await sendText(from,
          `📋 ${language.flag} Erkannte Sprache: ${language.label}\n\n` +
          `„${transcript}"\n\n` +
          `Ist das korrekt?\n• *ja* → Bericht-Entwurf erstellen\n• Oder schreib eine Korrektur`
        );
        return;
      }

      // Sprachnotiz zu laufender Session hinzufügen
      s.transcript += (s.transcript ? '\n' : '') + transcript;
      s.language = language;

      if (s.status === 'collecting') {
        s.status = 'preview_text';
        const combinedText = [s.transcript, s.text].filter(Boolean).join('\n');
        await sendText(from,
          `🎤 ${language.flag} ${language.label} erkannt.\n\n` +
          `📋 Erkannter Text:\n„${combinedText}"\n\n` +
          `Korrekt?\n• *ja* → Bericht-Entwurf\n• Oder schreib eine Korrektur`
        );
      } else if (s.status === 'awaiting_desc') {
        s.status = 'preview_text';
        const combinedText = [s.transcript, s.text].filter(Boolean).join('\n');
        await sendText(from,
          `🎤 ${language.flag} ${language.label} erkannt.\n\n` +
          `📋 „${combinedText}"\n\n` +
          `Korrekt? *ja* → weiter / Oder korrigieren`
        );
      } else {
        s.status = 'preview_text';
        resetTimer(from, s);
        await sendText(from,
          `🎤 Notiz hinzugefügt: „${transcript}"\n\n*ja* → weiter / Oder korrigieren`
        );
      }
      resetTimer(from, s);
    } catch (err) {
      console.error('Transkriptions-Fehler:', err.message);
      const hint = err.message.includes('401') ? 'OpenAI-Key ungültig.' :
        err.message.includes('400') ? 'Audioformat nicht erkannt.' : 'Transkription fehlgeschlagen.';
      await sendText(from, `⚠️ ${hint}\nBitte als Text schicken.`);
    }
    return;
  }

  // Unbekannter Typ
  await sendText(from, 'Ich verarbeite Text, Fotos, Videos und Sprachnotizen.');
}

// ---------------------------------------------------------------
// PDF erstellen und senden
// ---------------------------------------------------------------
async function sendReportPdfs(from, reports) {
  for (const report of reports) {
    const pdfBuffer = await generateReportPdfBuffer(report, company);
    const filename = `Tagesbericht_${safeName(report.kunde)}_${(report.datum || '').replace(/\./g, '-')}.pdf`;
    fs.writeFileSync(path.join(REPORTS_DIR, filename), pdfBuffer);
    const mediaId = await uploadMedia(pdfBuffer, filename, 'application/pdf');
    await sendDocument(from, mediaId, filename, `${report.kunde || ''} – ${report.datum || ''}`.trim());
  }
}

async function createAndSendReports(from, text, images) {
  try {
    const reports = await extractReports(text, images);
    await sendReportPdfs(from, reports);
  } catch (err) {
    console.error('Bericht-Fehler:', err);
    await sendText(from, '⚠️ Bericht konnte nicht erstellt werden.').catch(() => {});
  }
}

app.get('/health', (req, res) => res.json({ ok: true }));

if (require.main === module) {
  app.listen(PORT, () => console.log(`Server läuft auf Port ${PORT}`));
}

module.exports = app;
