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
  inhaber: process.env.COMPANY_OWNER || 'Musa Gueldes'
};

const REPORTS_DIR = path.join(__dirname, 'reports');
if (!fs.existsSync(REPORTS_DIR)) fs.mkdirSync(REPORTS_DIR);

const SESSION_TIMEOUT_MS = 30 * 60 * 1000;
const sessions = new Map();

function getSession(from) { return sessions.get(from) || null; }

function createSession(from) {
  const s = {
    status: 'collecting',
    photos: [],
    text: '',
    transcript: '',
    language: null,
    reportDraft: null,
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
  return (str || 'Bericht').replace(/[^a-zA-Z0-9_\- ]/g, '').trim().replace(/\s+/g, '_') || 'Bericht';
}

const JA_WORDS = ['ja', 'yes', 'ok', 'jo', 'gut', 'fertig', 'weiter', 'done', 'passt', 'stimmt', 'korrekt', 'alles gut', 'si'];
const NEIN_WORDS = ['nein', 'no', 'nicht', 'falsch', 'korrigier'];

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
  const entry = body?.entry?.[0];
  const changes = entry?.changes?.[0];
  const messages = changes?.value?.messages;
  console.log('Webhook erhalten - Feld:', changes?.field, 'Nachrichten:', messages?.length || 0);
  if (!messages?.length) return;
  for (const msg of messages) {
    console.log('Nachricht von', msg.from, 'Typ:', msg.type);
    try { await handleMessage(msg.from, msg); }
    catch (err) {
      console.error('Fehler [' + msg.from + ']:', err.message, err.stack?.split('\n')[1]);
      await sendText(msg.from, 'Fehler: ' + err.message.substring(0, 100)).catch(() => {});
    }
  }
}

async function handleMessage(from, msg) {
  const session = getSession(from);
  const type = msg.type;

  if (type === 'image') {
    console.log('Bild von', from, 'ID:', msg.image?.id);
    const s = session || createSession(from);
    s.status = 'collecting';
    try {
      const { buffer: imgBuffer, mimeType: imgMime } = await downloadMedia(msg.image.id);
      console.log('Bild OK:', imgBuffer.length, 'bytes');
      s.photos.push({ base64: imgBuffer.toString('base64'), mimeType: imgMime });
    } catch (dlErr) {
      console.error('Bild-Download-Fehler:', dlErr.message);
      await sendText(from, 'Foto konnte nicht geladen werden. Bitte nochmal schicken.');
      return;
    }
    if (msg.image.caption) s.text += (s.text ? '\n' : '') + msg.image.caption;
    resetTimer(from, s);
    await sendText(from, 'Foto ' + s.photos.length + ' erhalten.\n\nNoch mehr Fotos oder Videos? Schick sie weiter.\n\nWenn alle Medien vollstaendig sind - schreib ja');
    return;
  }

  if (type === 'video') {
    console.log('Video von', from, 'ID:', msg.video?.id);
    const s = session || createSession(from);
    s.status = 'collecting';
    await sendText(from, 'Video wird verarbeitet (Frames + Ton) ...');
    try {
      const { buffer: videoBuffer, mimeType: videoMime } = await downloadMedia(msg.video.id);
      const frames = extractFramesFromVideo(videoBuffer, videoMime, 8);
      s.photos.push(...frames);
      console.log('Video: ' + frames.length + ' Frames extrahiert.');
      try {
        const audioBuffer = extractAudioFromVideo(videoBuffer, videoMime);
        const { text: videoTranscript, language } = await transcribeAudio(audioBuffer, 'audio/ogg');
        if (videoTranscript) { s.transcript += (s.transcript ? '\n' : '') + videoTranscript; s.language = language; }
      } catch (e) { console.log('Kein Ton im Video:', e.message); }
      if (msg.video.caption) s.text += (s.text ? '\n' : '') + msg.video.caption;
      resetTimer(from, s);
      await sendText(from, 'Video verarbeitet: ' + frames.length + ' Frames.\n\nNoch mehr? Oder schreib ja wenn fertig.');
    } catch (dlErr) {
      console.error('Video-Download-Fehler:', dlErr.message);
      await sendText(from, 'Video konnte nicht geladen werden: ' + dlErr.message.substring(0, 80));
    }
    return;
  }

  if (type === 'text') {
    const rawText = msg.text.body;
    console.log('Text von', from, ':', rawText.substring(0, 60));

    if (!session) {
      await sendText(from, 'Notiz wird gelesen ...');
      await createAndSendReports(from, rawText, []);
      return;
    }

    resetTimer(from, session);

    if (session.status === 'collecting' && isJa(rawText)) {
      session.status = 'awaiting_desc';
      await sendText(from, 'Medien gespeichert (' + session.photos.length + ' Foto(s)/Frame(s)).\n\nJetzt Beschreibung hinzufuegen:\n- Sprachnotiz aufnehmen\n- Oder als Text schreiben\n\n(Baustelle, Arbeiten, Uhrzeit, Mitarbeiter)');
      return;
    }

    if (session.status === 'collecting') {
      session.text += (session.text ? '\n' : '') + rawText;
      await sendText(from, 'Notiz gespeichert.\n\nNoch mehr Fotos/Videos? Oder schreib ja wenn alles fertig ist.');
      return;
    }

    if (session.status === 'awaiting_desc') {
      session.text += (session.text ? '\n' : '') + rawText;
      session.status = 'preview_text';
      const combinedText = [session.transcript, session.text].filter(Boolean).join('\n');
      const langInfo = session.language ? ' (' + session.language.label + ')' : '';
      await sendText(from, 'Erkannter Text' + langInfo + ':\n\n"' + combinedText + '"\n\nIst das korrekt?\n- ja => Bericht-Entwurf erstellen\n- Oder schreib eine Korrektur');
      return;
    }

    if (session.status === 'preview_text') {
      if (isJa(rawText)) {
        await sendText(from, 'Bericht-Entwurf wird erstellt ...');
        const combinedText = [session.transcript, session.text].filter(Boolean).join('\n');
        const reports = await extractReports(combinedText, session.photos);
        session.reportDraft = reports;
        session.status = 'preview_report';
        for (let i = 0; i < reports.length; i++) {
          const r = reports[i];
          const nr = reports.length > 1 ? 'Bericht ' + (i + 1) + '/' + reports.length + ': ' : '';
          const arbeiten = r.arbeiten ? r.arbeiten.split('\n').map(l => ' - ' + l).join('\n') : ' -';
          const material = r.material ? r.material.split('\n').slice(0, 4).map(l => ' - ' + l).join('\n') : ' -';
          await sendText(from, nr + 'Entwurf:\n\nDatum: ' + (r.datum || '-') + ' Zeit: ' + (r.arbeitszeit || '-') + '\nKunde: ' + (r.kunde || '-') + '\nMitarbeiter: ' + (r.mitarbeiter || '-') + '\n\nArbeiten:\n' + arbeiten + '\n\nMaterial:\n' + material + '\n\nBesonderheiten: ' + (r.besonderheiten || '-') + '\n\nKorrekt? ja => PDF erstellen\nOder schreib was geaendert werden soll.');
        }
        return;
      } else {
        session.text = rawText;
        const combinedText = [session.transcript, session.text].filter(Boolean).join('\n');
        await sendText(from, 'Aktualisierter Text:\n\n"' + combinedText + '"\n\nja => weiter / Oder nochmals korrigieren');
        return;
      }
    }

    if (session.status === 'preview_report') {
      if (isJa(rawText)) {
        const reports = session.reportDraft;
        clearSession(from);
        await sendText(from, 'PDF wird erstellt ...');
        await sendReportPdfs(from, reports);
      } else {
        session.text = rawText;
        session.status = 'preview_text';
        const combinedText = [session.transcript, session.text].filter(Boolean).join('\n');
        await sendText(from, 'Korrektur gespeichert:\n\n"' + combinedText + '"\n\nja => neuen Entwurf erstellen');
      }
      return;
    }
  }

  if (type === 'audio') {
    console.log('Audio von', from, 'ID:', msg.audio?.id);
    const s = session || null;
    await sendText(from, 'Sprachnotiz wird transkribiert ...');
    try {
      const { buffer: audioBuffer, mimeType: audioMime } = await downloadMedia(msg.audio.id);
      const { text: transcript, language } = await transcribeAudio(audioBuffer, audioMime);
      console.log('Transkript [' + from + ']: ' + transcript);
      if (!s) {
        const newSession = createSession(from);
        newSession.transcript = transcript;
        newSession.language = language;
        newSession.status = 'preview_text';
        await sendText(from, language.flag + ' Erkannte Sprache: ' + language.label + '\n\n"' + transcript + '"\n\nIst das korrekt?\n- ja => Bericht-Entwurf erstellen\n- Oder schreib eine Korrektur');
        return;
      }
      s.transcript += (s.transcript ? '\n' : '') + transcript;
      s.language = language;
      const combinedText = [s.transcript, s.text].filter(Boolean).join('\n');
      if (s.status === 'collecting' || s.status === 'awaiting_desc') {
        s.status = 'preview_text';
        await sendText(from, language.flag + ' ' + language.label + ' erkannt.\n\nErkannter Text:\n"' + combinedText + '"\n\nKorrekt?\n- ja => Bericht-Entwurf\n- Oder schreib eine Korrektur');
      } else {
        s.status = 'preview_text';
        await sendText(from, 'Notiz hinzugefuegt: "' + transcript + '"\n\nja => weiter / Oder korrigieren');
      }
      resetTimer(from, s);
    } catch (err) {
      console.error('Transkriptions-Fehler:', err.message);
      const hint = err.message.includes('401') ? 'OpenAI-Key ungueltig.' : err.message.includes('400') ? 'Audioformat nicht erkannt.' : 'Transkription fehlgeschlagen.';
      await sendText(from, 'Fehler: ' + hint + '\nBitte als Text schicken.');
    }
    return;
  }

  console.log('Unbekannter Typ:', type, 'von', from);
  await sendText(from, 'Ich verarbeite Text, Fotos, Videos und Sprachnotizen.');
}

async function sendReportPdfs(from, reports) {
  for (const report of reports) {
    const pdfBuffer = await generateReportPdfBuffer(report, company);
    const filename = 'Tagesbericht_' + safeName(report.kunde) + '_' + (report.datum || '').replace(/\./g, '-') + '.pdf';
    fs.writeFileSync(path.join(REPORTS_DIR, filename), pdfBuffer);
    const mediaId = await uploadMedia(pdfBuffer, filename, 'application/pdf');
    await sendDocument(from, mediaId, filename, (report.kunde || '') + ' - ' + (report.datum || ''));
  }
}

async function createAndSendReports(from, text, images) {
  try {
    const reports = await extractReports(text, images);
    await sendReportPdfs(from, reports);
  } catch (err) {
    console.error('Bericht-Fehler:', err);
    await sendText(from, 'Bericht konnte nicht erstellt werden.').catch(() => {});
  }
}

app.get('/health', (req, res) => res.json({ ok: true }));

if (require.main === module) {
  app.listen(PORT, () => console.log('Server laeuft auf Port ' + PORT));
}

module.exports = app;
