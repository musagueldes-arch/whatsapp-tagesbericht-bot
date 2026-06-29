const { todayStr } = require('./util');

function buildSystemPrompt() {
  return (
    "Du bist ein Assistent fuer G-Therm Haustechnik (Heizung/Sanitaer/Elektro, Bochum). " +
    "Du wandelst WhatsApp-Nachrichten, Sprachnotizen und Fotos/Videos von Handwerkern in strukturierte Tagesberichte um. " +
    "Die Monteure koennen auf Deutsch, Polnisch (pl), Russisch (ru) oder Aserbaidschanisch (az) schreiben oder sprechen. " +
    "Du erkennst die Sprache automatisch und fuellst die Felder IMMER AUF DEUTSCH aus. " +
    "Antworte AUSSCHLIESSLICH mit einem JSON-Array, ohne Markdown, ohne Code-Fences, ohne Erklaerungen. " +
    "Jedes Objekt = ein Tagesbericht (eine Baustelle/ein Tag). " +
    "Mehrere Baustellen/Tage in einer Nachricht → mehrere Objekte. " +
    "Erfinde nichts. Leere Felder = leerer String oder leeres Array. " +
    "Heutiges Datum: " + todayStr() + ". " +
    "FOTOS & OCR: Beschreibe was auf den Fotos zu sehen ist (Schaeden, Installationen, Materialien, " +
    "handgeschriebene Notizen, Lieferscheine, Aufmasszettel) und trage es in 'besonderheiten' ein. " +
    "Handschriftliche Texte und Lieferscheine bitte vollstaendig in 'material' oder 'arbeiten' uebertragen. " +
    "MATERIAL-MATRIX: Wenn Rohre oder Fittings sichtbar sind, zaehle und erkenne: " +
    "Fitting-Typ (Winkel 90°, T-Stueck, Muffe, Kupplung, Uebergang usw.), Nennweite (DN15/22/28 usw.), " +
    "geschaetzte Rohrlängen pro Abschnitt. Trage das in 'material' ein, z.B. '2x Winkel 90° DN22', '1,5m Rohr DN15'. " +
    "Jedes Objekt hat exakt diese Felder: " +
    '{"datum":"TT.MM.JJJJ","kunde":"Kunde/Baustelle/Adresse",' +
    '"referenz":"Auftrags-/Projektnummer oder leer",' +
    '"mitarbeiter":["Name"],"arbeitszeit":"z.B. 07:00-14:30 oder Stundenzahl",' +
    '"arbeiten":["durchgefuehrte Arbeit als kurzer Punkt auf Deutsch"],' +
    '"material":["verwendetes Material auf Deutsch inkl. Fittings/Rohre wenn sichtbar"],' +
    '"besonderheiten":"Foto-Beschreibung, Probleme, Maengel, offene Punkte – auf Deutsch"}'
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
  if (t.startsWith('```')) t = t.replace(/^```(json)?/, '').replace(/```$/, '').trim();
  try { return JSON.parse(t); }
  catch (e) {
    const start = t.indexOf('['), end = t.lastIndexOf(']');
    if (start >= 0 && end > start) return JSON.parse(t.slice(start, end + 1));
    throw new Error('KI-Antwort konnte nicht gelesen werden');
  }
}

async function extractReports(rawText, images = []) {
  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) throw new Error('ANTHROPIC_API_KEY nicht gesetzt');

  const contentParts = [];
  for (const img of images) {
    contentParts.push({
      type: 'image',
      source: { type: 'base64', media_type: img.mimeType, data: img.base64 }
    });
  }
  const textContent = rawText && rawText.trim()
    ? rawText.trim()
    : '(Kein Begleittext – bitte alle Informationen aus den Fotos entnehmen)';
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
      max_tokens: 2000,
      system: buildSystemPrompt(),
      messages: [{ role: 'user', content: contentParts }]
    })
  });

  if (!resp.ok) throw new Error(`Anthropic API Fehler ${resp.status}: ${await resp.text()}`);

  const data = await resp.json();
  const textBlocks = (data.content || []).filter(b => b.type === 'text').map(b => b.text);
  const parsed = parseModelText(textBlocks.join('\n'));
  const arr = Array.isArray(parsed) ? parsed : [parsed];

  return arr.map(o => ({
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
