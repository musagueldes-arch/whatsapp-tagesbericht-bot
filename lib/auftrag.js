'use strict';
const puppeteer = require('puppeteer');

function todayStr() {
  return new Date().toLocaleDateString('de-DE');
}

// Generiert eine Auftragsnummer: A-YYYYMMDD-XXX
function generateAuftragsnummer() {
  const d = new Date();
  const date = d.getFullYear().toString() +
    String(d.getMonth()+1).padStart(2,'0') +
    String(d.getDate()).padStart(2,'0');
  const rand = String(Math.floor(Math.random()*900)+100);
  return `A-${date}-${rand}`;
}

async function generateAuftragPdfBuffer(auftrag, company) {
  const nr = auftrag.auftragsnummer || generateAuftragsnummer();
  const datum = auftrag.datum || todayStr();
  const kunde = auftrag.kunde || '';
  const adresseKunde = auftrag.adresseKunde || '';
  const objekt = auftrag.objekt || auftrag.baustelle || '';
  const mitarbeiter = (auftrag.mitarbeiter || '').split(/[,\n]/).map(s=>s.trim()).filter(Boolean);
  const arbeiten = (auftrag.arbeiten || '').split('\n').map(s=>s.trim()).filter(Boolean);
  const material = (auftrag.material || '').split('\n').map(s=>s.trim()).filter(Boolean);
  const hinweise = auftrag.hinweise || auftrag.besonderheiten || '';
  const termin = auftrag.termin || auftrag.datum || datum;
  const uhrzeit = auftrag.uhrzeit || auftrag.arbeitszeit || '';
  const prioritaet = auftrag.prioritaet || 'Normal';

  const firma = company.firma || 'G-Therm Haustechnik';
  const compAdresse = company.adresse || 'Lindener Str. 111 · 44879 Bochum';
  const compTelefon = company.telefon || '0234 - 544 618 55';
  const inhaber = company.inhaber || 'Musa Güldes';

  // Mitarbeiter-Zeilen (min 3)
  const mitRows = [];
  for (let i = 0; i < Math.max(3, mitarbeiter.length); i++) {
    mitRows.push(`<tr>
      <td style="padding:6px 8px;border:0.5pt solid #2C4A8A;">${mitarbeiter[i] || ''}</td>
      <td style="padding:6px 8px;border:0.5pt solid #2C4A8A;width:80px;"></td>
      <td style="padding:6px 8px;border:0.5pt solid #2C4A8A;width:80px;"></td>
      <td style="padding:6px 8px;border:0.5pt solid #2C4A8A;width:80px;"></td>
    </tr>`);
  }

  // Arbeiten-Zeilen
  const arbeitenHtml = arbeiten.length
    ? arbeiten.map(a => `<div style="padding:2px 0;font-size:9pt;">&#9679; ${a}</div>`).join('')
    : '<div style="height:20px"></div>';

  // Material-Zeilen (min 6)
  const matRowCount = Math.max(6, material.length + 2);
  let matRows = '';
  for (let i = 0; i < matRowCount; i++) {
    const line = material[i] || '';
    const match = line.match(/^(\d+[.,]?\d*\s*\w*)\s+(.+)/);
    const menge = match ? match[1] : '';
    const bez = match ? match[2] : line;
    const bg = i%2===0 ? 'white' : '#F0F3F8';
    matRows += `<tr style="background:${bg}">
      <td style="padding:4px 6px;border:0.5pt solid #2C4A8A;width:12%">${menge}</td>
      <td style="padding:4px 6px;border:0.5pt solid #2C4A8A;">${bez}</td>
      <td style="padding:4px 6px;border:0.5pt solid #2C4A8A;width:14%;text-align:right"></td>
      <td style="padding:4px 6px;border:0.5pt solid #2C4A8A;width:14%;text-align:right"></td>
    </tr>`;
  }

  // Priorität-Badge
  const prioColor = prioritaet === 'Dringend' ? '#C0392B' : prioritaet === 'Hoch' ? '#E67E22' : '#27AE60';

  const html = `<!DOCTYPE html>
<html lang="de">
<head>
<meta charset="UTF-8">
<style>
  * { margin:0;padding:0;box-sizing:border-box; }
  body { font-family:Arial,Helvetica,sans-serif;font-size:9pt;color:#111;background:white; }
  .page { width:210mm;min-height:297mm;padding:0; }
</style>
</head>
<body>
<div class="page">

  <!-- HEADER -->
  <div style="background:#1B2A4A;color:white;display:flex;justify-content:space-between;align-items:center;padding:10px 14px;">
    <div>
      <div style="display:flex;gap:16px;margin-bottom:5px;">
        <div style="text-align:center;font-size:6pt;color:#a0b0cc"><div style="font-size:14pt">🔥</div>HEIZUNG</div>
        <div style="text-align:center;font-size:6pt;color:#a0b0cc"><div style="font-size:14pt">💧</div>SANITÄR</div>
        <div style="text-align:center;font-size:6pt;color:#a0b0cc"><div style="font-size:14pt">💨</div>LÜFTUNG</div>
      </div>
    </div>
    <div style="text-align:right;">
      <div style="font-size:16pt;font-weight:900;letter-spacing:1px;">G-THERM HAUSTECHNIK</div>
      <div style="font-size:7.5pt;color:#CFD5E3;margin-top:2px;">${compAdresse}</div>
      <div style="font-size:7.5pt;color:#CFD5E3;">Telefon: ${compTelefon}</div>
    </div>
  </div>
  <div style="background:#C0392B;height:5px;"></div>

  <!-- TITEL + NR -->
  <div style="padding:8px 14px 4px 14px;display:flex;justify-content:space-between;align-items:center;">
    <div>
      <div style="font-size:16pt;font-weight:900;color:#1B2A4A;">Arbeitsauftrag</div>
      <div style="font-size:8pt;color:#555;margin-top:1px;">Intern · Für Mitarbeiter</div>
    </div>
    <div style="text-align:right;">
      <div style="background:#1B2A4A;color:white;padding:4px 12px;border-radius:4px;font-size:9pt;font-weight:700;letter-spacing:1px;">${nr}</div>
      <div style="font-size:8pt;color:#555;margin-top:3px;">Ausgestellt: ${datum}</div>
      <div style="background:${prioColor};color:white;padding:2px 8px;border-radius:3px;font-size:7.5pt;font-weight:700;display:inline-block;margin-top:3px;">⚡ ${prioritaet}</div>
    </div>
  </div>

  <!-- INFO-BLOCK: Kunde + Objekt + Termin -->
  <div style="margin:6px 14px;display:grid;grid-template-columns:1fr 1fr 1fr;gap:6px;">
    <div style="border:0.5pt solid #2C4A8A;border-radius:4px;padding:6px 8px;background:#F0F3F8;">
      <div style="font-size:6.5pt;font-weight:700;color:#1B2A4A;margin-bottom:3px;text-transform:uppercase;">Auftraggeber / Kunde</div>
      <div style="font-size:9.5pt;font-weight:700;">${kunde}</div>
      <div style="font-size:8pt;color:#444;margin-top:2px;">${adresseKunde}</div>
    </div>
    <div style="border:0.5pt solid #2C4A8A;border-radius:4px;padding:6px 8px;background:#F0F3F8;">
      <div style="font-size:6.5pt;font-weight:700;color:#1B2A4A;margin-bottom:3px;text-transform:uppercase;">Objekt / Baustelle</div>
      <div style="font-size:9.5pt;font-weight:700;">${objekt}</div>
    </div>
    <div style="border:0.5pt solid #2C4A8A;border-radius:4px;padding:6px 8px;background:#F0F3F8;">
      <div style="font-size:6.5pt;font-weight:700;color:#1B2A4A;margin-bottom:3px;text-transform:uppercase;">Termin</div>
      <div style="font-size:9.5pt;font-weight:700;">${termin}</div>
      ${uhrzeit ? `<div style="font-size:8pt;color:#444;margin-top:2px;">⏰ ${uhrzeit}</div>` : ''}
    </div>
  </div>

  <!-- MITARBEITER-TABELLE -->
  <div style="margin:6px 14px;">
    <div style="background:#1B2A4A;color:white;padding:4px 8px;font-size:8pt;font-weight:700;border-radius:3px 3px 0 0;">👷 Eingeteilte Mitarbeiter</div>
    <table style="width:100%;border-collapse:collapse;">
      <thead>
        <tr style="background:#2C4A8A;color:white;">
          <th style="padding:5px 8px;text-align:left;border:0.5pt solid #2C4A8A;font-size:7.5pt;">Name / Monteur</th>
          <th style="padding:5px 8px;text-align:center;border:0.5pt solid #2C4A8A;font-size:7.5pt;width:80px;">Ankunft</th>
          <th style="padding:5px 8px;text-align:center;border:0.5pt solid #2C4A8A;font-size:7.5pt;width:80px;">Abfahrt</th>
          <th style="padding:5px 8px;text-align:center;border:0.5pt solid #2C4A8A;font-size:7.5pt;width:80px;">Std. gesamt</th>
        </tr>
      </thead>
      <tbody>${mitRows.join('')}</tbody>
    </table>
  </div>

  <!-- DURCHZUFÜHRENDE ARBEITEN -->
  <div style="margin:6px 14px;">
    <div style="background:#1B2A4A;color:white;padding:4px 8px;font-size:8pt;font-weight:700;border-radius:3px 3px 0 0;">🔧 Durchzuführende Arbeiten</div>
    <div style="border:0.5pt solid #2C4A8A;padding:8px 10px;min-height:70px;background:white;">
      ${arbeitenHtml}
    </div>
  </div>

  <!-- HINWEISE -->
  ${hinweise ? `
  <div style="margin:6px 14px;">
    <div style="background:#E67E22;color:white;padding:4px 8px;font-size:8pt;font-weight:700;border-radius:3px 3px 0 0;">⚠️ Hinweise / Besonderheiten</div>
    <div style="border:0.5pt solid #E67E22;padding:8px 10px;background:#FFF9F0;font-size:8.5pt;">${hinweise}</div>
  </div>` : ''}

  <!-- MATERIAL -->
  <div style="margin:6px 14px;">
    <div style="background:#1B2A4A;color:white;padding:4px 8px;font-size:8pt;font-weight:700;border-radius:3px 3px 0 0;">📦 Material / Werkzeug</div>
    <table style="width:100%;border-collapse:collapse;">
      <thead>
        <tr style="background:#2C4A8A;color:white;">
          <th style="padding:4px 6px;text-align:left;border:0.5pt solid #2C4A8A;font-size:7.5pt;">Menge</th>
          <th style="padding:4px 6px;text-align:left;border:0.5pt solid #2C4A8A;font-size:7.5pt;">Bezeichnung</th>
          <th style="padding:4px 6px;text-align:right;border:0.5pt solid #2C4A8A;font-size:7.5pt;">Einzel</th>
          <th style="padding:4px 6px;text-align:right;border:0.5pt solid #2C4A8A;font-size:7.5pt;">Gesamt</th>
        </tr>
      </thead>
      <tbody>${matRows}</tbody>
    </table>
  </div>

  <!-- UNTERSCHRIFTEN -->
  <div style="margin:8px 14px;display:flex;gap:8px;">
    <div style="flex:1;border:0.5pt solid #2C4A8A;padding:6px 8px;min-height:50px;">
      <div style="font-size:6.5pt;font-weight:700;color:#1B2A4A;margin-bottom:14px;">Auftraggeber / Chef</div>
      <div style="border-top:0.5pt solid #aaa;padding-top:2px;font-size:6pt;color:#777;">${inhaber} · Datum</div>
    </div>
    <div style="flex:1;border:0.5pt solid #2C4A8A;padding:6px 8px;min-height:50px;">
      <div style="font-size:6.5pt;font-weight:700;color:#1B2A4A;margin-bottom:14px;">Monteur / Bestätigung</div>
      <div style="border-top:0.5pt solid #aaa;padding-top:2px;font-size:6pt;color:#777;">Unterschrift · Datum</div>
    </div>
    <div style="flex:1;border:0.5pt solid #2C4A8A;padding:6px 8px;min-height:50px;">
      <div style="font-size:6.5pt;font-weight:700;color:#1B2A4A;margin-bottom:14px;">Kunde / Abnahme</div>
      <div style="border-top:0.5pt solid #aaa;padding-top:2px;font-size:6pt;color:#777;">Unterschrift · Datum</div>
    </div>
  </div>

  <!-- FOOTER -->
  <div style="margin:4px 14px;text-align:center;font-size:6.5pt;color:#888;border-top:0.5pt solid #ddd;padding-top:4px;">
    ${firma} · ${compAdresse} · Tel: ${compTelefon} · Auftrag ${nr}
  </div>

</div>
</body>
</html>`;

  const browser = await puppeteer.launch({
    headless: true,
    args: ['--no-sandbox','--disable-setuid-sandbox','--disable-dev-shm-usage','--disable-gpu','--no-zygote','--single-process']
  });
  try {
    const page = await browser.newPage();
    await page.setContent(html, { waitUntil: 'networkidle0' });
    const pdfBuffer = await page.pdf({ format:'A4', printBackground:true, margin:{top:'0',right:'0',bottom:'0',left:'0'} });
    return pdfBuffer;
  } finally {
    await browser.close();
  }
}

module.exports = { generateAuftragPdfBuffer, generateAuftragsnummer };
