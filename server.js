// Redeploy trigger - neue Telefonnummer
require('dotenv').config();
const express = require('express');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const { extractReports } = require('./lib/anthropic');
const { generateReportPdfBuffer } = require('./lib/pdf');
const { sendText, uploadMedia, sendDocument, downloadMedia } = require('./lib/whatsapp');
const { transcribeAudio, extractAudioFromVideo, extractFramesFromVideo } = require('./lib/transcribe');

const app = express();
app.use(express.json({ limit: '10mb' }));

const PORT = process.env.PORT || 3000;
const VERIFY_TOKEN = process.env.WHATSAPP_VERIFY_TOKEN || 'changeme';
const BASE_URL = process.env.BASE_URL || 'https://whatsapp-tagesbericht-bot-production.up.railway.app';

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
// Unterschrift-Tokens: token → { report, company, from, filename, expiresAt }
// ---------------------------------------------------------------
const signatureRequests = new Map();

// ---------------------------------------------------------------
// Whitelist
// ---------------------------------------------------------------
function isAllowed(from) {
  const allowed = process.env.ALLOWED_NUMBERS;
  if (!allowed || !allowed.trim()) return true;
  const list = allowed.split(',').map(n => n.trim().replace(/\D/g, ''));
  return list.includes(from.replace(/\D/g, ''));
}

// ---------------------------------------------------------------
// Session-Status
// ---------------------------------------------------------------
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
// Haupt-Nachrichtenverarbeitung
// ---------------------------------------------------------------
async function handleMessage(from, msg) {
  const session = getSession(from);
  const type = msg.type;

  if (type === 'image') {
    const s = session || createSession(from);
    s.status = 'collecting';
    const { buffer: imgBuffer, mimeType: imgMime } = await downloadMedia(msg.image.id);
    s.photos.push({ base64: imgBuffer.toString('base64'), mimeType: imgMime });
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
    const { buffer: videoBuffer, mimeType } = await downloadMedia(msg.video.id);
    const frames = extractFramesFromVideo(videoBuffer, mimeType, 8);
    s.photos.push(...frames);
    try {
      const audioBuffer = extractAudioFromVideo(videoBuffer, mimeType);
      const { text: videoTranscript, language } = await transcribeAudio(audioBuffer, 'audio/ogg');
      if (videoTranscript) {
        s.transcript += (s.transcript ? '\n' : '') + videoTranscript;
        s.language = language;
      }
    } catch (e) {
      console.log('Kein Ton im Video:', e.message);
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

  if (type === 'text') {
    const rawText = msg.text.body;

    if (!session) {
      await sendText(from, '🔍 Notiz wird gelesen …');
      await sendText(from, '📝 Bericht wird erstellt …');
      await createAndSendReports(from, rawText, []);
      return;
    }

    resetTimer(from, session);

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

    if (session.status === 'collecting') {
      session.text += (session.text ? '\n' : '') + rawText;
      await sendText(from, `📝 Notiz gespeichert.\n\nNoch mehr Fotos/Videos? Oder schreib *ja* wenn alles vollständig ist.`);
      return;
    }

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

    if (session.status === 'preview_text') {
      if (isJa(rawText)) {
        await sendText(from, '🔍 Bericht-Entwurf wird erstellt …');
        const combinedText = [session.transcript, session.text].filter(Boolean).join('\n');
        const reports = await extractReports(combinedText, session.photos);
        const fotoBuffers = session.photos.map(p => Buffer.from(p.base64, 'base64'));
        reports.forEach(r => { r.fotos = fotoBuffers; });
        session.reportDraft = reports;
        session.status = 'preview_report';

        for (let i = 0; i < reports.length; i++) {
          const r = reports[i];
          const nr = reports.length > 1 ? `Bericht ${i + 1}/${reports.length}: ` : '';
          const arbeiten = r.arbeiten ? r.arbeiten.split('\n').map(l => ` • ${l}`).join('\n') : ' -';
          const material = r.material ? r.material.split('\n').slice(0, 4).map(l => ` • ${l}`).join('\n') : ' -';
          await sendText(from,
            `📋 ${nr}Entwurf:\n\n` +
            `📅 ${r.datum || '-'} ⏱ ${r.arbeitszeit || '-'}\n` +
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

    if (session.status === 'preview_report') {
      if (isJa(rawText)) {
        const reports = session.reportDraft;
        clearSession(from);
        await sendText(from, '📄 PDF wird erstellt …');
        await sendReportPdfs(from, reports);
      } else {
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

  if (type === 'audio') {
    const s = session || null;
    await sendText(from, '🎤 Sprachnotiz wird transkribiert …');
    try {
      const { buffer: audioBuffer, mimeType } = await downloadMedia(msg.audio.id);
      const { text: transcript, language } = await transcribeAudio(audioBuffer, mimeType);
      console.log(`Transkript [${from}] ${language.flag}: ${transcript}`);

      if (!s) {
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
        await sendText(from, `🎤 Notiz hinzugefügt: „${transcript}"\n\n*ja* → weiter / Oder korrigieren`);
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

  await sendText(from, 'Ich verarbeite Text, Fotos, Videos und Sprachnotizen.');
}

// ---------------------------------------------------------------
// PDF erstellen und senden + Unterschrift-Link
// ---------------------------------------------------------------
async function sendReportPdfs(from, reports) {
  for (const report of reports) {
    const pdfBuffer = await generateReportPdfBuffer(report, company);
    const filename = `Tagesbericht_${safeName(report.kunde)}_${(report.datum || '').replace(/\./g, '-')}.pdf`;
    fs.writeFileSync(path.join(REPORTS_DIR, filename), pdfBuffer);
    const mediaId = await uploadMedia(pdfBuffer, filename, 'application/pdf');
    await sendDocument(from, mediaId, filename, `${report.kunde || ''} – ${report.datum || ''}`.trim());

    // Unterschrift-Link generieren
    const token = crypto.randomBytes(20).toString('hex');
    signatureRequests.set(token, {
      report,
      company,
      from,
      filename,
      expiresAt: Date.now() + 48 * 60 * 60 * 1000 // 48h gültig
    });
    const signUrl = `${BASE_URL}/sign/${token}`;
    await sendText(from,
      `✅ PDF wurde erstellt!\n\n` +
      `✍️ *Unterschrift anfordern:*\n` +
      `Schick diesen Link an den Kunden:\n` +
      `${signUrl}\n\n` +
      `Der Kunde öffnet den Link, unterschreibt mit dem Finger und du bekommst das unterschriebene PDF per WhatsApp.\n` +
      `_(Link gilt 48 Stunden)_`
    );
  }
}

async function createAndSendReports(from, text, images) {
  try {
    const reports = await extractReports(text, images);
    const imgBuffers = images.map(p => Buffer.from(p.base64, 'base64'));
    reports.forEach(r => { r.fotos = imgBuffers; });
    await sendReportPdfs(from, reports);
  } catch (err) {
    console.error('Bericht-Fehler:', err);
    await sendText(from, '⚠️ Bericht konnte nicht erstellt werden.').catch(() => {});
  }
}

// ---------------------------------------------------------------
// Unterschrift-Seite (GET) – HTML mit Canvas
// ---------------------------------------------------------------
app.get('/sign/:token', (req, res) => {
  const data = signatureRequests.get(req.params.token);
  if (!data) return res.status(404).send('<h2>Link nicht gefunden oder abgelaufen.</h2>');
  if (Date.now() > data.expiresAt) {
    signatureRequests.delete(req.params.token);
    return res.status(410).send('<h2>Link ist abgelaufen.</h2>');
  }

  const { report } = data;
  const html = `<!DOCTYPE html>
<html lang="de">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0, user-scalable=no">
  <title>Tagesbericht unterschreiben</title>
  <style>
    * { box-sizing: border-box; margin: 0; padding: 0; }
    body { font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif; background: #f0f2f5; min-height: 100vh; }
    .header { background: #1B2A4A; color: white; padding: 20px; text-align: center; }
    .header h1 { font-size: 22px; margin-bottom: 4px; }
    .header p { font-size: 13px; color: #CFD5E3; }
    .card { background: white; margin: 16px; border-radius: 12px; padding: 20px; box-shadow: 0 2px 8px rgba(0,0,0,0.08); }
    .info-row { display: flex; justify-content: space-between; padding: 8px 0; border-bottom: 1px solid #f0f0f0; font-size: 14px; }
    .info-row:last-child { border-bottom: none; }
    .label { color: #8B92A0; font-weight: 600; font-size: 12px; text-transform: uppercase; }
    .value { color: #222; }
    h2 { font-size: 16px; color: #1B2A4A; margin-bottom: 12px; }
    .sig-area { position: relative; }
    canvas { border: 2px dashed #E8622C; border-radius: 8px; touch-action: none; cursor: crosshair; width: 100%; display: block; background: #fafafa; }
    .sig-hint { text-align: center; color: #8B92A0; font-size: 12px; margin-top: 6px; }
    .btn-row { display: flex; gap: 10px; margin-top: 16px; }
    .btn { flex: 1; padding: 14px; border: none; border-radius: 10px; font-size: 16px; font-weight: 600; cursor: pointer; }
    .btn-clear { background: #f0f2f5; color: #444; }
    .btn-send { background: #E8622C; color: white; }
    .btn-send:disabled { background: #ccc; cursor: not-allowed; }
    .success { display: none; text-align: center; padding: 40px 20px; }
    .success-icon { font-size: 60px; margin-bottom: 16px; }
    .success h2 { color: #1B2A4A; margin-bottom: 8px; }
    .success p { color: #666; font-size: 14px; }
    .loading { display: none; text-align: center; padding: 20px; color: #666; }
  </style>
</head>
<body>
  <div class="header">
    <h1>✍️ Tagesbericht unterschreiben</h1>
    <p>${data.company.firma || 'G-Therm Haustechnik'}</p>
  </div>

  <div id="mainContent">
    <div class="card">
      <h2>📋 Berichtdetails</h2>
      <div class="info-row"><span class="label">Datum</span><span class="value">${report.datum || '-'}</span></div>
      <div class="info-row"><span class="label">Kunde</span><span class="value">${report.kunde || '-'}</span></div>
      <div class="info-row"><span class="label">Mitarbeiter</span><span class="value">${report.mitarbeiter || '-'}</span></div>
      <div class="info-row"><span class="label">Arbeitszeit</span><span class="value">${report.arbeitszeit || '-'}</span></div>
    </div>

    <div class="card">
      <h2>✍️ Unterschrift</h2>
      <div class="sig-area">
        <canvas id="sigCanvas" height="160"></canvas>
        <p class="sig-hint">Mit dem Finger oder Stift unterschreiben</p>
      </div>
      <div class="btn-row">
        <button class="btn btn-clear" onclick="clearSig()">🗑 Löschen</button>
        <button class="btn btn-send" id="sendBtn" onclick="sendSignature()">✅ Unterschrift senden</button>
      </div>
    </div>

    <div class="loading" id="loading">
      <p>⏳ Unterschrift wird verarbeitet …</p>
    </div>
  </div>

  <div class="success" id="successMsg">
    <div class="success-icon">🎉</div>
    <h2>Vielen Dank!</h2>
    <p>Ihre Unterschrift wurde übermittelt.<br>Das unterschriebene PDF wird dem Techniker zugestellt.</p>
  </div>

  <script>
    const canvas = document.getElementById('sigCanvas');
    const ctx = canvas.getContext('2d');
    let drawing = false;
    let hasSig = false;

    // Canvas-Grösse setzen
    function resizeCanvas() {
      const w = canvas.offsetWidth;
      canvas.width = w;
      canvas.height = 160;
      ctx.strokeStyle = '#1B2A4A';
      ctx.lineWidth = 2.5;
      ctx.lineCap = 'round';
      ctx.lineJoin = 'round';
    }
    resizeCanvas();

    function getPos(e) {
      const rect = canvas.getBoundingClientRect();
      const scaleX = canvas.width / rect.width;
      const scaleY = canvas.height / rect.height;
      if (e.touches) {
        return {
          x: (e.touches[0].clientX - rect.left) * scaleX,
          y: (e.touches[0].clientY - rect.top) * scaleY
        };
      }
      return {
        x: (e.clientX - rect.left) * scaleX,
        y: (e.clientY - rect.top) * scaleY
      };
    }

    canvas.addEventListener('mousedown', e => { drawing = true; const p = getPos(e); ctx.beginPath(); ctx.moveTo(p.x, p.y); });
    canvas.addEventListener('mousemove', e => { if (!drawing) return; const p = getPos(e); ctx.lineTo(p.x, p.y); ctx.stroke(); hasSig = true; });
    canvas.addEventListener('mouseup', () => drawing = false);
    canvas.addEventListener('mouseleave', () => drawing = false);

    canvas.addEventListener('touchstart', e => { e.preventDefault(); drawing = true; const p = getPos(e); ctx.beginPath(); ctx.moveTo(p.x, p.y); }, { passive: false });
    canvas.addEventListener('touchmove', e => { e.preventDefault(); if (!drawing) return; const p = getPos(e); ctx.lineTo(p.x, p.y); ctx.stroke(); hasSig = true; }, { passive: false });
    canvas.addEventListener('touchend', () => drawing = false);

    function clearSig() {
      ctx.clearRect(0, 0, canvas.width, canvas.height);
      hasSig = false;
    }

    async function sendSignature() {
      if (!hasSig) { alert('Bitte zuerst unterschreiben.'); return; }
      const btn = document.getElementById('sendBtn');
      btn.disabled = true;
      document.getElementById('loading').style.display = 'block';

      const dataUrl = canvas.toDataURL('image/png');
      try {
        const res = await fetch(window.location.href, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ signature: dataUrl })
        });
        if (res.ok) {
          document.getElementById('mainContent').style.display = 'none';
          document.getElementById('loading').style.display = 'none';
          document.getElementById('successMsg').style.display = 'block';
        } else {
          alert('Fehler beim Senden. Bitte nochmals versuchen.');
          btn.disabled = false;
          document.getElementById('loading').style.display = 'none';
        }
      } catch (e) {
        alert('Netzwerkfehler. Bitte nochmals versuchen.');
        btn.disabled = false;
        document.getElementById('loading').style.display = 'none';
      }
    }
  </script>
</body>
</html>`;

  res.send(html);
});

// ---------------------------------------------------------------
// Unterschrift empfangen (POST) → PDF regenerieren + senden
// ---------------------------------------------------------------
app.post('/sign/:token', async (req, res) => {
  const data = signatureRequests.get(req.params.token);
  if (!data) return res.status(404).json({ error: 'Token nicht gefunden' });
  if (Date.now() > data.expiresAt) {
    signatureRequests.delete(req.params.token);
    return res.status(410).json({ error: 'Link abgelaufen' });
  }

  const { signature } = req.body;
  if (!signature) return res.status(400).json({ error: 'Keine Unterschrift' });

  res.json({ ok: true }); // sofort antworten

  try {
    signatureRequests.delete(req.params.token); // einmalig nutzbar

    const { report, company: comp, from, filename } = data;

    // PDF mit Unterschrift generieren
    const pdfBuffer = await generateReportPdfBuffer(report, comp, signature);
    const signedFilename = filename.replace('.pdf', '_unterschrieben.pdf');
    fs.writeFileSync(path.join(REPORTS_DIR, signedFilename), pdfBuffer);

    const mediaId = await uploadMedia(pdfBuffer, signedFilename, 'application/pdf');
    await sendDocument(from, mediaId, signedFilename,
      `✍️ Unterschrieben: ${report.kunde || ''} – ${report.datum || ''}`.trim()
    );
    await sendText(from, `✅ Der Kunde hat den Tagesbericht unterschrieben!\nDas unterschriebene PDF wurde dir gerade gesendet.`);

    console.log(`Unterschrift erhalten für ${report.kunde} (${from})`);
  } catch (err) {
    console.error('Unterschrift-Verarbeitungs-Fehler:', err.message);
  }
});

app.get('/health', (req, res) => res.json({ ok: true }));

if (require.main === module) {
  app.listen(PORT, () => console.log(`Server läuft auf Port ${PORT}`));
}

module.exports = app;
