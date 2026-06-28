const { todayStr } = require('./util');

function buildSystemPrompt() {
  return (
    "Du wandelst unstrukturierte WhatsApp-Nachrichten von Handwerkern (Heizung/Sanitaer/Elektro) " +
    "in strukturierte Tagesberichte um. Antworte AUSSCHLIESSLICH mit einem JSON-Array, ohne Markdown, " +
    "ohne Code-Fences, ohne Erklaerungen davor oder danach. Jedes Objekt im Array ist ein eigenstaendiger " +
    "Tagesbericht (eine Baustelle/ein Kunde/ein Tag). Falls der Text mehrere Baustellen, Kunden oder Tage " +
    "behandelt, erstelle fuer jeden ein eigenes Objekt. Erfinde nichts, was nicht im Text steht - wenn etwas " +
    "nicht erkennbar ist, lasse das Feld leer (leerer String bzw. leeres Array). Heutiges Datum zur " +
    "Orientierung, falls im Text 'heute' o.ae. steht: " + todayStr() + ". " +
    "Bei 'arbeitskraefte' liste jede genannte Person mit ihren Stunden als Zahl auf (z.B. 'Ali und Murat je 8 Stunden' wird zu zwei Eintraegen mit stunden:8). Nenne nur tatsaechlich erwaehnte Personen. " +
    "Jedes Objekt hat exakt diese Felder: " +
    '{"datum":"TT.MM.JJJJ","kunde":"Kunde/Baustelle/Adresse","referenz":"Auftrags-/Projektnummer falls erkennbar, sonst leer",' +
    '"mitarbeiter":["Name"],"arbeitszeit":"z.B. 07:00-14:30 oder Stundenzahl",' +
    '"arbeitskraefte":[{"name":"Vorname wie genannt","stunden":8}],' +
    '"arbeiten":["durchgefuehrte Arbeit als kurzer Punkt"],"material":["verwendetes Material"],' +
    '"besonderheiten":"Probleme, Maengel, offene Punkte - sonst leer"}'
  );
}

function buildVisionSystemPrompt(modus) {
  const ziel =
    modus === 'materialliste'
      ? "Auf dem Bild ist eine handschriftliche oder gedruckte MATERIALLISTE. Lies alle Positionen ab " +
        "(Material, Mengen, Bezeichnungen) und trage sie in das Feld \"material\" ein. Setze \"kunde\" auf " +
        "\"Materialliste\" falls kein Kunde/Baustelle erkennbar ist, sonst auf den erkennbaren Kunden."
      : "Auf dem Bild ist eine handschriftliche oder gedruckte Notiz zu einem Arbeitseinsatz. Lies den Inhalt " +
        "ab und erstelle daraus einen vollstaendigen Tagesbericht. Falls das Bild eindeutig nur eine reine " +
        "Materialliste ist, fuelle stattdessen nur das Feld \"material\" und setze \"kunde\" auf \"Materialliste\".";
  return (
    "Du liest Handschrift und Notizen von Handwerkern (Heizung/Sanitaer/Elektro) von einem Foto ab und " +
    "wandelst sie in strukturierte Daten um. " + ziel + " " +
    "Antworte AUSSCHLIESSLICH mit einem JSON-Array, ohne Markdown, ohne Code-Fences, ohne Erklaerungen. " +
    "Jedes Objekt ist ein eigenstaendiger Bericht. Erfinde nichts, was nicht lesbar ist - wenn etwas " +
    "nicht erkennbar ist, lasse das Feld leer. Falls einzelne Woerter unleserlich sind, gib dein Bestes " +
    "und markiere sehr unsichere Stellen mit (?). Heutiges Datum, falls 'heute' o.ae. gemeint ist: " +
    todayStr() + ". " +
    "Bei 'arbeitskraefte' liste jede genannte Person mit ihren Stunden als Zahl auf (z.B. 'Ali und Murat je 8 Stunden' wird zu zwei Eintraegen mit stunden:8). Nenne nur tatsaechlich erwaehnte Personen. " +
    "Jedes Objekt hat exakt diese Felder: " +
    '{"datum":"TT.MM.JJJJ","kunde":"Kunde/Baustelle/Adresse","referenz":"Auftrags-/Projektnummer falls erkennbar, sonst leer",' +
    '"mitarbeiter":["Name"],"arbeitszeit":"z.B. 07:00-14:30 oder Stundenzahl",' +
    '"arbeitskraefte":[{"name":"Vorname wie genannt","stunden":8}],' +
    '"arbeiten":["durchgefuehrte Arbeit als kurzer Punkt"],"material":["Material/Position als Punkt"],' +
    '"besonderheiten":"Probleme, Maengel, offene Punkte - sonst leer"}'
  );
}

function toMultiline(v) {
  if (Array.isArray(v)) return v.join('\n');
  return v === undefined || v === null ? '' : String(v);
}

function toCSV(v) {
  if (Array.isArray(v)) return v.join(', ');
  return v === undefined || v === null ? '' : String(v);
}

function parseModelText(text) {
  let t = text.trim();
  if (t.startsWith('\`\`\`')) {
    t = t.replace(/^\`\`\`(json)?/, '').replace(/\`\`\`$/, '').trim();
  }
  try {
    return JSON.parse(t);
  } catch (e) {
    const start = t.indexOf('[');
    const end = t.lastIndexOf(']');
    if (start >= 0 && end > start) {
      return JSON.parse(t.slice(start, end + 1));
    }
    throw new Error('Antwort der KI konnte nicht als JSON gelesen werden');
  }
}

function normalizeReports(parsed) {
  const arr = Array.isArray(parsed) ? parsed : [parsed];
  return arr.map((o) => ({
    datum: o.datum || todayStr(),
    kunde: o.kunde || '',
    referenz: o.referenz || '',
    mitarbeiter: toCSV(o.mitarbeiter),
    arbeitszeit: o.arbeitszeit || '',
    arbeiten: toMultiline(o.arbeiten),
    material: toMultiline(o.material),
    besonderheiten: o.besonderheiten || '',
    arbeitskraefte: Array.isArray(o.arbeitskraefte) ? o.arbeitskraefte
      .filter((a) => a && (a.name || a.stunden))
      .map((a) => ({ name: String(a.name || '').trim(), stunden: Number(a.stunden) || 0 })) : []
  }));
}

async function callAnthropic(systemPrompt, userContent) {
  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) {
    throw new Error('ANTHROPIC_API_KEY ist nicht gesetzt (.env pruefen)');
  }

  const resp = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'x-api-key': apiKey,
      'anthropic-version': '2023-06-01'
    },
    body: JSON.stringify({
      model: 'claude-sonnet-4-6',
      max_tokens: 1500,
      system: systemPrompt,
      messages: [{ role: 'user', content: userContent }]
    })
  });

  if (!resp.ok) {
    const errText = await resp.text();
        throw new Error(`Anthropic API Fehler ${resp.status}: ${errText}`);
  }

  const data = await resp.json();
  const textBlocks = (data.content || [])
    .filter((b) => b.type === 'text')
    .map((b) => b.text);
  return parseModelText(textBlocks.join('\n'));
}

async function extractReports(rawText) {
  const parsed = await callAnthropic(buildSystemPrompt(), rawText);
  return normalizeReports(parsed);
}

async function extractReportsFromImage(imageBuffer, mimeType, captionHint) {
  const hint = (captionHint || '').toLowerCase();
  const modus = /material|liste|teile|ersatzteil/.test(hint) ? 'materialliste' : 'tagesbericht';
  const mt = mimeType && mimeType.startsWith('image/') ? mimeType : 'image/jpeg';
  const content = [
    {
      type: 'image',
      source: {
        type: 'base64',
        media_type: mt,
        data: imageBuffer.toString('base64')
      }
    }
  ];
  if (captionHint && captionHint.trim()) {
    content.push({ type: 'text', text: 'Zusatzinfo vom Absender: ' + captionHint.trim() });
  }
  const parsed = await callAnthropic(buildVisionSystemPrompt(modus), content);
  return normalizeReports(parsed);
}

module.exports = { extractReports, extractReportsFromImage, parseModelText, buildSystemPrompt };
