// Kostenkalkulation fuer G-Therm Tagesberichte
// Stundensaetze pro Mitarbeiter werden aus der Umgebungsvariable TEAM_RATES gelesen (JSON),
// damit keine Mitarbeiternamen im oeffentlichen Code stehen.
// Format von TEAM_RATES: {"alex":65,"ramadan":75,"nasir":65,"musa":85,"yasar":55, ...}

const MWST_SATZ = Number(process.env.MWST_SATZ || 19);
const STANDARD_SATZ = Number(process.env.STANDARD_STUNDENSATZ || 65);

function ladeSaetze() {
  try {
    const raw = process.env.TEAM_RATES;
    if (!raw) return {};
    const obj = JSON.parse(raw);
    const norm = {};
    for (const k of Object.keys(obj)) {
      norm[k.trim().toLowerCase()] = Number(obj[k]) || 0;
    }
    return norm;
  } catch (e) {
    console.error('TEAM_RATES konnte nicht gelesen werden (kein gueltiges JSON):', e.message);
    return {};
  }
}

function satzFuer(name, saetze) {
  const key = String(name || '').trim().toLowerCase();
  if (key && saetze[key]) return saetze[key];
  return STANDARD_SATZ;
}

function formatEuro(betrag) {
  return betrag.toLocaleString('de-DE', { minimumFractionDigits: 2, maximumFractionDigits: 2 }) + ' EUR';
}

// Liefert ein Kalkulationsobjekt oder null, wenn keine Arbeitskraefte/Stunden vorhanden sind.
function berechneKalkulation(report) {
  const kraefte = Array.isArray(report.arbeitskraefte) ? report.arbeitskraefte : [];
  const mitStunden = kraefte.filter((a) => a && Number(a.stunden) > 0);
  if (!mitStunden.length) return null;

  const saetze = ladeSaetze();
  const positionen = mitStunden.map((a) => {
    const stunden = Number(a.stunden) || 0;
    const satz = satzFuer(a.name, saetze);
    const summe = stunden * satz;
    return {
      name: a.name || 'Unbekannt',
      stunden,
      satz,
      summe,
      satzText: formatEuro(satz),
      summeText: formatEuro(summe)
    };
  });

  const netto = positionen.reduce((s, p) => s + p.summe, 0);
  const mwst = netto * (MWST_SATZ / 100);
  const brutto = netto + mwst;

  return {
    positionen,
    netto,
    mwst,
    brutto,
    mwstSatz: MWST_SATZ,
    nettoText: formatEuro(netto),
    mwstText: formatEuro(mwst),
    bruttoText: formatEuro(brutto)
  };
}

module.exports = { berechneKalkulation, formatEuro };
