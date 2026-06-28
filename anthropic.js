const { todayStr } = require('./util');

function buildSystemPrompt() {
  return (
    "Du wandelst unstrukturierte WhatsApp-Nachrichten und Fotos von Handwerkern (Heizung/Sanitaer/Elektro) " +
    "in strukturierte Tagesberichte um. Antworte AUSSCHLIESSLICH mit einem JSON-Array, ohne Markdown, " +
    "ohne Code-Fences, ohne Erklaerungen davor oder danach. Jedes Objekt im Array ist ein eigenstaendiger " +
    "Tagesbericht (eine Baustelle/ein Kunde/ein Tag). Falls der Text mehrere Baustellen, Kunden oder Tage " +
    "behandelt, erstelle fuer jeden ein eigenes Objekt. Erfinde nichts, was nicht im Text oder auf den Fotos " +
    "erkennbar ist - wenn etwas nicht erkennbar ist, lasse das Feld leer. Heutiges Datum: " + todayStr() + ". " +
    "Beschreibe bei Fotos kurz, was darauf zu sehen ist (Schaeden, Installationen, Materialien) und fuege " +
    "das in das Feld 'besonderheiten' ein, sofern es nicht schon aus dem Text hervorgeht. " +
    "Jedes Objekt hat exakt diese Felder: " +
    '{"datum":"TT.MM.JJJJ","kunde":"Kunde/Baustelle/Adresse","referenz":"Auftrags-/Projektnummer falls erkennbar, sonst leer",' +
    '"mitarbeiter":["Name"],"arbeitszeit":"z.B. 07:00-14:30 oder Stundenzahl",' +
    '"arbeiten":["durchgefuehrte Arbeit als kurzer Punkt"],"material":["verwendetes Material"],' +
    '"besonderheiten":"Probleme, Maengel, offene Punkte, Foto-Beschreibung - sonst leer"}'
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
  if (t.startsWith('```')) {
    t = t.replace(/^```(json)?/, '').replace(/```$/, '').trim();
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

// rawText: String (Beschreibung des Monteurs)
// images: Array von { base64, mimeType } (optional, kann leer sein)
async function extractReports(rawText, images = []) {
  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) throw new Error('ANTHROPIC_API_KEY ist nicht gesetzt (.env pruefen)');

  // Nachrichteninhalt aufbauen: erst Bilder, dann Text
  const contentParts = [];

  for (const img of images) {
    contentParts.push({
      type: 'image',
      source: { type: 'base64', media_type: img.mimeType, data: img.base64 }
    });
  }

  const textContent = rawText && rawText.trim()
    ? rawText.trim()
    : '(Kein Begleittext – bitte Informationen aus den Fotos entnehmen)';

  contentParts.push({ type: 'text', text: textContent });

  const resp = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'x-api-key': apiKey,
      'anthropic-version': '2023-06-01'
    },
    body: JSON.stringify({
      model: 'claude-sonnet-4-6',
      max_tokens: 1000,
      system: buildSystemPrompt(),
      messages: [{ role: 'user', content: contentParts }]
    })
  });

  if (!resp.ok) {
    const errText = await resp.text();
    throw new Error(`Anthropic API Fehler ${resp.status}: ${errText}`);
  }

  const data = await resp.json();
  const textBlocks = (data.content || []).filter((b) => b.type === 'text').map((b) => b.text);
  const parsed = parseModelText(textBlocks.join('\n'));
  const arr = Array.isArray(parsed) ? parsed : [parsed];

  return arr.map((o) => ({
    datum: o.datum || todayStr(),
    kunde: o.kunde || '',
    referenz: o.referenz || '',
    mitarbeiter: toCSV(o.mitarbeiter),
    arbeitszeit: o.arbeitszeit || '',
    arbeiten: toMultiline(o.arbeiten),
    material: toMultiline(o.material),
    besonderheiten: o.besonderheiten || ''
  }));
}

module.exports = { extractReports, parseModelText, buildSystemPrompt };
