// Redeploy trigger - neue Telefonnummer
require('dotenv').config();
const express = require('express');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const { extractReports } = require('./lib/anthropic');
const { generateReportPdfBuffer } = require('./lib/pdf');
const { generateAuftragPdfBuffer } = require('./lib/auftrag');
const { sendText, uploadMedia, sendDocument, downloadMedia } = require('./lib/whatsapp');
const { transcribeAudio, extractAudioFromVideo, extractFramesFromVideo } = require('./lib/transcribe');

const app = express();
app.use(express.json({ limit: '10mb' }));

const PORT = process.env.PORT || 3000;
const VERIFY_TOKEN = process.env.WHATSAPP_VERIFY_TOKEN || 'changeme';
const BASE_URL = process.env.BASE_URL || 'https://whatsapp-tagesbericht-bot-production.up.railway.app';

const company = {
  firma: process.env.COMPANY_NAME || 'G-Therm Haustechnik',
  adresse: process.env.COMPANY_ADDRESS || 'Lindener Str. 111 · 44879 Bochum',
  telefon: process.env.COMPANY_PHONE || '0234 - 544 618 55',
  email: process.env.COMPANY_EMAIL || '',
  inhaber: process.env.COMPANY_OWNER || 'Musa Güldes'
};

const REPORTS_DIR = path.join(__dirname, 'reports');
if (!fs.existsSync(REPORTS_DIR)) fs.mkdirSync(REPORTS_DIR);

// Unterschrift-Tokens
const signatureRequests = new Map();

// Whitelist
function isAllowed(from) {
  const allowed = process.env.ALLOWED_NUMBERS;
  if (!allowed || !allowed.trim()) return true;
  const list = allowed.split(',').map(n => n.trim().replace(/\D/g, ''));
  return list.includes(from.replace(/\D/g, ''));
}

// Session
const SESSION_TIMEOUT_MS = 30 * 60 * 1000;
const sessions = new Map();

function getSession(from) { return sessions.get(from) || null; }

function createSession(from, mode = 'bericht') {
  const s = {
    mode,            // 'bericht' oder 'auftrag'
    status: mode === 'auftrag' ? 'auftrag_details' : 'collecting',
    photos: [],
    text: '',
    transcript: '',
    language: null,
    reportDraft: null,
    auftragData: null,
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
  return (str || 'Dokument').replace(/[^a-zA-Z0-9äöüÄÖÜß_\- ]/g, '').trim().replace(/\s+/g, '_') || 'Dokument';
}

const JA_WORDS = ['ja', 'yes', 'ok', 'jo', 'gut', 'fertig', 'weiter', 'done', 'passt', 'stimmt', 'korrekt', 'alles gut', 'si', 'да', 'bəli'];
const NEIN_WORDS = ['nein', 'no', 'nicht', 'änder', 'falsch', 'korrigier', 'correc'];

function isJa(text) {
  if (!text) return false;
  return JA_WORDS.some(w => text.toLowerCase().trim().startsWith(w));
}

// Webhook
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
    if (!isAllowed(msg.from)) return;
    try { await handleMessage(msg.from, msg); }
    catch (err) {
      console.error('Fehler:', err.message);
      await sendText(msg.from, '⚠️ Fehler. Bitte erneut versuchen.').catch(() => {});
    }
  }
}

// ---------------------------------------------------------------
// AUFTRAG-FLOW Hilfsfunktionen
// ---------------------------------------------------------------

async function handleAuftragFlow(from, session, rawText) {
  resetTimer(from, session);

  // Schritt 1: Details eingeben
  if (session.status === 'auftrag_details') {
    session.auftragData = { rawText };
    session.status = 'auftrag_preview';

    // KI strukturiert den Auftrag
    await sendText(from, '🔍 Auftrag wird strukturiert …');
    const auftrag = await extractAuftragFromText(rawText);
    session.auftragData = auftrag;

    const mitList = auftrag.mitarbeiter
      ? auftrag.mitarbeiter.split(/[,\n]/).map(s=>s.trim()).filter(Boolean).map(m => ` • ${m}`).join('\n')
      : ' -';
    const arbList = auftrag.arbeiten
      ? auftrag.arbeiten.split('\n').slice(0,5).map(a=>` • ${a}`).join('\n')
      : ' -';

    await sendText(from,
      `📋 *Auftrags-Entwurf:*\n\n` +
      `🏠 *Kunde:* ${auftrag.kunde || '-'}\n` +
      `📍 *Objekt:* ${auftrag.objekt || '-'}\n` +
      `📅 *Termin:* ${auftrag.termin || auftrag.datum || '-'}\n` +
      `⏰ *Uhrzeit:* ${auftrag.uhrzeit || '-'}\n` +
      `⚡ *Priorität:* ${auftrag.prioritaet || 'Normal'}\n\n` +
      `👷 *Mitarbeiter:*\n${mitList}\n\n` +
      `🔧 *Arbeiten:*\n${arbList}\n\n` +
      `Korrekt? *ja* → PDF erstellen\nOder schreib was geändert werden soll.`
    );
    return;
  }

  // Schritt 2: Bestätigung
  if (session.status === 'auftrag_preview') {
    if (isJa(rawText)) {
      const auftrag = session.auftragData;
      clearSession(from);
      await sendText(from, '📄 Arbeitsauftrag wird erstellt …');
      await sendAuftragPdf(from, auftrag);
    } else {
      // Korrektur
      session.auftragData.rawText = (session.auftragData.rawText || '') + '\n' + rawText;
      session.status = 'auftrag_details';
      await sendText(from, `✏️ Korrektur gespeichert. Bitte gib den vollständigen Auftrag nochmal ein (mit Änderungen):`);
    }
    return;
  }
}

async function extractAuftragFromText(text) {
  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) throw new Error('ANTHROPIC_API_KEY nicht gesetzt');

  const system = `Du bist ein Assistent für G-Therm Haustechnik.
Wandle die Auftragsbeschreibung in ein strukturiertes JSON-Objekt um.
Antworte NUR mit JSON, ohne Markdown, ohne Erklärungen.
Felder:
{
  "kunde": "Name des Kunden/Auftraggebers",
  "adresseKunde": "Adresse des Kunden (falls angegeben)",
  "objekt": "Objekt/Baustelle/Adresse wo gearbeitet wird",
  "termin": "Datum TT.MM.JJJJ",
  "uhrzeit": "Uhrzeit z.B. 07:00 oder 07:00-15:00",
  "mitarbeiter": "Mitarbeiter durch Komma getrennt",
  "arbeiten": "Durchzuführende Arbeiten, eine pro Zeile",
  "material": "Benötigtes Material, eine Position pro Zeile",
  "hinweise": "Besondere Hinweise oder leerer String",
  "prioritaet": "Normal oder Hoch oder Dringend",
  "datum": "Erstellungsdatum heute"
}
Heutiges Datum: ${new Date().toLocaleDateString('de-DE')}.
Erfinde nichts. Fehlende Infos = leerer String.`;

  const resp = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: { 'Content-Type':'application/json', 'x-api-key':apiKey, 'anthropic-version':'2023-06-01' },
    body: JSON.stringify({
      model: 'claude-sonnet-4-6',
      max_tokens: 1000,
      system,
      messages: [{ role:'user', content: text }]
    })
  });
  if (!resp.ok) throw new Error('Anthropic Fehler ' + resp.status);
  const data = await resp.json();
  const txt = data.content.filter(b=>b.type==='text').map(b=>b.text).join('');
  let t = txt.trim();
  if (t.startsWith('```')) t = t.replace(/^```(json)?/,'').replace(/```$/,'').trim();
  try { return JSON.parse(t); } catch(e) { return { rawText: text, arbeiten: text, datum: new Date().toLocaleDateString('de-DE') }; }
}

async function sendAuftragPdf(from, auftrag) {
  const pdfBuffer = await generateAuftragPdfBuffer(auftrag, company);
  const nr = auftrag.auftragsnummer || ('A-' + Date.now());
  const filename = `Arbeitsauftrag_${safeName(auftrag.kunde || 'Auftrag')}_${(auftrag.termin||auftrag.datum||'').replace(/\./g,'-')}.pdf`;
  fs.writeFileSync(path.join(REPORTS_DIR, filename), pdfBuffer);
  const mediaId = await uploadMedia(pdfBuffer, filename, 'application/pdf');
  await sendDocument(from, mediaId, filename, `📋 Arbeitsauftrag: ${auftrag.kunde || ''} – ${auftrag.termin || auftrag.datum || ''}`.trim());
  await sendText(from,
    `✅ *Arbeitsauftrag erstellt!*\n\n` +
    `👷 Mitarbeiter: ${auftrag.mitarbeiter || '-'}\n` +
    `📅 Termin: ${auftrag.termin || auftrag.datum || '-'}\n\n` +
    `Den PDF-Auftrag einfach an deine Mitarbeiter weiterleiten! 💪`
  );
}

// ---------------------------------------------------------------
// HAUPT-NACHRICHTENVERARBEITUNG
// ---------------------------------------------------------------
async function handleMessage(from, msg) {
  const session = getSession(from);
  const type = msg.type;

  // AUFTRAG-TRIGGER: User schreibt "Auftrag" ohne aktive Session
  if (type === 'text') {
    const rawText = msg.text.body;
    const lower = rawText.toLowerCase().trim();

    // Trigger: "auftrag" → neuen Auftrag starten
    if ((lower === 'auftrag' || lower.startsWith('auftrag ')) && !session) {
      const s = createSession(from, 'auftrag');
      if (lower === 'auftrag') {
        // Nur "Auftrag" → Bot fragt nach Details
        await sendText(from,
          `📋 *Neuer Arbeitsauftrag*\n\n` +
          `Schick mir die Auftragsdetails in einer Nachricht oder als Sprachnotiz:\n\n` +
          `• 🏠 Kunde / Auftraggeber\n` +
          `• 📍 Objekt / Baustelle\n` +
          `• 📅 Termin (Datum + Uhrzeit)\n` +
          `• 👷 Mitarbeiter (wer soll hin)\n` +
          `• 🔧 Was ist zu tun\n` +
          `• 📦 Welches Material wird gebraucht\n` +
          `• ⚡ Priorität (Normal / Hoch / Dringend)\n\n` +
          `_Einfach alles in einer Nachricht schreiben oder als Sprachnotiz!`
        );
      } else {
        // "Auftrag: ..." → Details direkt dabei
        const details = rawText.slice(7).trim();
        s.status = 'auftrag_details';
        await handleAuftragFlow(from, s, details);
      }
      return;
    }

    // Aktive Auftrag-Session
    if (session && session.mode === 'auftrag') {
      await handleAuftragFlow(from, session, rawText);
      return;
    }
  }

  // Sprachnotiz in aktiver Auftrag-Session
  if (type === 'audio' && session && session.mode === 'auftrag') {
    await sendText(from, '🎤 Sprachnotiz wird transkribiert …');
    try {
      const { buffer: audioBuffer, mimeType } = await downloadMedia(msg.audio.id);
      const { text: transcript } = await transcribeAudio(audioBuffer, mimeType);
      await handleAuftragFlow(from, session, transcript);
    } catch(err) {
      await sendText(from, '⚠️ Transkription fehlgeschlagen. Bitte als Text schicken.');
    }
    return;
  }

  // -----------------------------------------------
  // NORMALER TAGESBERICHT-FLOW (unverändert)
  // -----------------------------------------------
  if (type === 'image') {
    const s = session || createSession(from, 'bericht');
    s.status = 'collecting';
    const { buffer: imgBuffer, mimeType: imgMime } = await downloadMedia(msg.image.id);
    s.photos.push({ base64: imgBuffer.toString('base64'), mimeType: imgMime });
    if (msg.image.caption) s.text += (s.text ? '\n' : '') + msg.image.caption;
    resetTimer(from, s);
    await sendText(from,
      `📸 Foto ${s.photos.length} erhalten.\n\nNoch mehr Fotos oder Videos? Schick sie weiter.\n\nWenn alle Medien vollständig sind → schreib *ja*`
    );
    return;
  }

  if (type === 'video') {
    const s = session || createSession(from, 'bericht');
    s.status = 'collecting';
    await sendText(from, '🎬 Video wird verarbeitet …');
    const { buffer: videoBuffer, mimeType } = await downloadMedia(msg.video.id);
    const frames = extractFramesFromVideo(videoBuffer, mimeType, 8);
    s.photos.push(...frames);
    try {
      const audioBuffer = extractAudioFromVideo(videoBuffer, mimeType);
      const { text: videoTranscript, language } = await transcribeAudio(audioBuffer, 'audio/ogg');
      if (videoTranscript) { s.transcript += (s.transcript ? '\n' : '') + videoTranscript; s.language = language; }
    } catch(e) { console.log('Kein Ton:', e.message); }
    if (msg.video.caption) s.text += (s.text ? '\n' : '') + msg.video.caption;
    resetTimer(from, s);
    await sendText(from, `🎬 Video verarbeitet: ${frames.length} Frames.\n\nNoch mehr Medien? Oder *ja* wenn fertig.`);
    return;
  }

  if (type === 'text') {
    const rawText = msg.text.body;

    if (!session) {
      await sendText(from, '🔍 Notiz wird gelesen …');
      await createAndSendReports(from, rawText, []);
      return;
    }

    resetTimer(from, session);

    if (session.status === 'collecting' && isJa(rawText)) {
      session.status = 'awaiting_desc';
      await sendText(from, `✅ ${session.photos.length} Foto(s) gespeichert.\n\nJetzt Beschreibung eingeben (Text oder Sprachnotiz).`);
      return;
    }
    if (session.status === 'collecting') {
      session.text += (session.text ? '\n' : '') + rawText;
      await sendText(from, '📝 Notiz gespeichert. Noch mehr Fotos oder *ja* wenn fertig.');
      return;
    }
    if (session.status === 'awaiting_desc') {
      session.text += (session.text ? '\n' : '') + rawText;
      session.status = 'preview_text';
      const combined = [session.transcript, session.text].filter(Boolean).join('\n');
      await sendText(from, `📋 Text:\n\n"${combined}"\n\nKorrekt? *ja* → Bericht erstellen`);
      return;
    }
    if (session.status === 'preview_text') {
      if (isJa(rawText)) {
        await sendText(from, '🔍 Bericht-Entwurf wird erstellt …');
        const combined = [session.transcript, session.text].filter(Boolean).join('\n');
        const reports = await extractReports(combined, session.photos);
        const fotoBuffers = session.photos.map(p => Buffer.from(p.base64, 'base64'));
        reports.forEach(r => { r.fotos = fotoBuffers; });
        session.reportDraft = reports;
        session.status = 'preview_report';
        for (const r of reports) {
          const arbeiten = r.arbeiten ? r.arbeiten.split('\n').slice(0,4).map(l=>` • ${l}`).join('\n') : ' -';
          await sendText(from,
            `📋 Entwurf:\n📅 ${r.datum||'-'} ⏱ ${r.arbeitszeit||'-'}\n🏠 ${r.kunde||'-'}\n👷 ${r.mitarbeiter||'-'}\n\nArbeiten:\n${arbeiten}\n\nKorrekt? *ja* → PDF`
          );
        }
      } else {
        session.text = rawText; session.status = 'preview_text';
        const combined = [session.transcript, session.text].filter(Boolean).join('\n');
        await sendText(from, `📋 Aktualisiert:\n"${combined}"\n\n*ja* → weiter`);
      }
      return;
    }
    if (session.status === 'preview_report') {
      if (isJa(rawText)) {
        const reports = session.reportDraft;
        clearSession(from);
        await sendText(from, '📄 PDF wird erstellt …');
        await sendReportPdfs(from, reports);
      } else {
        session.text = rawText; session.status = 'preview_text';
        await sendText(from, `📋 Korrektur: "${rawText}"\n\n*ja* → neuen Entwurf`);
      }
      return;
    }
  }

  if (type === 'audio') {
    await sendText(from, '🎤 Sprachnotiz wird transkribiert …');
    try {
      const { buffer: audioBuffer, mimeType } = await downloadMedia(msg.audio.id);
      const { text: transcript, language } = await transcribeAudio(audioBuffer, mimeType);
      const s = session || createSession(from, 'bericht');
      s.transcript += (s.transcript ? '\n' : '') + transcript;
      s.language = language;
      s.status = 'preview_text';
      const combined = [s.transcript, s.text].filter(Boolean).join('\n');
      await sendText(from, `🎤 ${language.flag} "${combined}"\n\nKorrekt? *ja* → weiter`);
      resetTimer(from, s);
    } catch(err) {
      await sendText(from, '⚠️ Transkription fehlgeschlagen. Bitte als Text schicken.');
    }
    return;
  }

  await sendText(from, '📋 Schreib *Auftrag* für einen Arbeitsauftrag oder schick Fotos/Notizen für einen Tagesbericht.');
}

// PDF senden + Unterschrift-Link
async function sendReportPdfs(from, reports) {
  for (const report of reports) {
    const pdfBuffer = await generateReportPdfBuffer(report, company);
    const filename = `Tagesbericht_${safeName(report.kunde)}_${(report.datum||'').replace(/\./g,'-')}.pdf`;
    fs.writeFileSync(path.join(REPORTS_DIR, filename), pdfBuffer);
    const mediaId = await uploadMedia(pdfBuffer, filename, 'application/pdf');
    await sendDocument(from, mediaId, filename, `${report.kunde||''} – ${report.datum||''}`.trim());
    const token = crypto.randomBytes(20).toString('hex');
    signatureRequests.set(token, { report, company, from, filename, expiresAt: Date.now() + 48*60*60*1000 });
    const signUrl = `${BASE_URL}/sign/${token}`;
    await sendText(from, `✅ PDF erstellt!\n\n✍️ Unterschrift-Link für den Kunden:\n${signUrl}\n\n_(gilt 48h)_`);
  }
}

async function createAndSendReports(from, text, images) {
  try {
    const reports = await extractReports(text, images);
    reports.forEach(r => { r.fotos = []; });
    await sendReportPdfs(from, reports);
  } catch(err) {
    console.error('Fehler:', err);
    await sendText(from, '⚠️ Bericht konnte nicht erstellt werden.').catch(()=>{});
  }
}

// Unterschrift-Seite
app.get('/sign/:token', (req, res) => {
  const data = signatureRequests.get(req.params.token);
  if (!data) return res.status(404).send('<h2>Link nicht gefunden oder abgelaufen.</h2>');
  if (Date.now() > data.expiresAt) { signatureRequests.delete(req.params.token); return res.status(410).send('<h2>Link abgelaufen.</h2>'); }
  const { report } = data;
  res.send(`<!DOCTYPE html><html lang="de"><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1,user-scalable=no"><title>Unterschreiben</title><style>*{box-sizing:border-box;margin:0;padding:0}body{font-family:-apple-system,sans-serif;background:#f0f2f5}.header{background:#1B2A4A;color:white;padding:20px;text-align:center}.header h1{font-size:22px}.card{background:white;margin:16px;border-radius:12px;padding:20px;box-shadow:0 2px 8px rgba(0,0,0,.08)}.info-row{display:flex;justify-content:space-between;padding:8px 0;border-bottom:1px solid #f0f0f0;font-size:14px}.label{color:#8B92A0;font-weight:600;font-size:12px;text-transform:uppercase}h2{font-size:16px;color:#1B2A4A;margin-bottom:12px}canvas{border:2px dashed #E8622C;border-radius:8px;touch-action:none;cursor:crosshair;width:100%;display:block;background:#fafafa}.sig-hint{text-align:center;color:#8B92A0;font-size:12px;margin-top:6px}.btn-row{display:flex;gap:10px;margin-top:16px}.btn{flex:1;padding:14px;border:none;border-radius:10px;font-size:16px;font-weight:600;cursor:pointer}.btn-clear{background:#f0f2f5;color:#444}.btn-send{background:#E8622C;color:white}.btn-send:disabled{background:#ccc}.success{display:none;text-align:center;padding:40px 20px}</style></head><body><div class="header"><h1>✍️ Unterschreiben</h1><p>${data.company.firma}</p></div><div id="mc"><div class="card"><h2>📋 Details</h2><div class="info-row"><span class="label">Datum</span><span>${report.datum||'-'}</span></div><div class="info-row"><span class="label">Kunde</span><span>${report.kunde||'-'}</span></div><div class="info-row"><span class="label">Mitarbeiter</span><span>${report.mitarbeiter||'-'}</span></div></div><div class="card"><h2>✍️ Unterschrift</h2><canvas id="c" height="160"></canvas><p class="sig-hint">Mit Finger unterschreiben</p><div class="btn-row"><button class="btn btn-clear" onclick="cl()">🗑 Löschen</button><button class="btn btn-send" id="sb" onclick="send()">✅ Senden</button></div></div></div><div class="success" id="ok"><div style="font-size:60px">🎉</div><h2>Danke!</h2><p>Unterschrift übermittelt.</p></div><script>const c=document.getElementById('c'),ctx=c.getContext('2d');let drawing=false,has=false;c.width=c.offsetWidth;ctx.strokeStyle='#1B2A4A';ctx.lineWidth=2.5;ctx.lineCap='round';function gp(e){const r=c.getBoundingClientRect(),sx=c.width/r.width,sy=c.height/r.height;return e.touches?{x:(e.touches[0].clientX-r.left)*sx,y:(e.touches[0].clientY-r.top)*sy}:{x:(e.clientX-r.left)*sx,y:(e.clientY-r.top)*sy}}c.addEventListener('mousedown',e=>{drawing=true;const p=gp(e);ctx.beginPath();ctx.moveTo(p.x,p.y)});c.addEventListener('mousemove',e=>{if(!drawing)return;const p=gp(e);ctx.lineTo(p.x,p.y);ctx.stroke();has=true});c.addEventListener('mouseup',()=>drawing=false);c.addEventListener('touchstart',e=>{e.preventDefault();drawing=true;const p=gp(e);ctx.beginPath();ctx.moveTo(p.x,p.y)},{passive:false});c.addEventListener('touchmove',e=>{e.preventDefault();if(!drawing)return;const p=gp(e);ctx.lineTo(p.x,p.y);ctx.stroke();has=true},{passive:false});c.addEventListener('touchend',()=>drawing=false);function cl(){ctx.clearRect(0,0,c.width,c.height);has=false}async function send(){if(!has){alert('Bitte unterschreiben');return}document.getElementById('sb').disabled=true;const r=await fetch(location.href,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({signature:c.toDataURL()})});if(r.ok){document.getElementById('mc').style.display='none';document.getElementById('ok').style.display='block'}else{alert('Fehler');document.getElementById('sb').disabled=false}}</script></body></html>`);
});

app.post('/sign/:token', async (req, res) => {
  const data = signatureRequests.get(req.params.token);
  if (!data) return res.status(404).json({ error: 'nicht gefunden' });
  if (Date.now() > data.expiresAt) { signatureRequests.delete(req.params.token); return res.status(410).json({ error: 'abgelaufen' }); }
  const { signature } = req.body;
  if (!signature) return res.status(400).json({ error: 'keine Unterschrift' });
  res.json({ ok: true });
  try {
    signatureRequests.delete(req.params.token);
    const { report, company: comp, from, filename } = data;
    const pdfBuffer = await generateReportPdfBuffer(report, comp, signature);
    const signedFilename = filename.replace('.pdf', '_unterschrieben.pdf');
    fs.writeFileSync(path.join(REPORTS_DIR, signedFilename), pdfBuffer);
    const mediaId = await uploadMedia(pdfBuffer, signedFilename, 'application/pdf');
    await sendDocument(from, mediaId, signedFilename, `✍️ Unterschrieben: ${report.kunde||''}`);
    await sendText(from, '✅ Kunde hat unterschrieben! Unterschriebenes PDF gesendet.');
  } catch(err) { console.error('Unterschrift-Fehler:', err.message); }
});

app.get('/health', (req, res) => res.json({ ok: true }));

if (require.main === module) {
  app.listen(PORT, () => console.log(`Server läuft auf Port ${PORT}`));
}

module.exports = app;
