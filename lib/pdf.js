'use strict';
const puppeteer = require('puppeteer');
const { todayStr } = require('./util');
const { berechneKalkulation } = require('./kalkulation');

function linesFrom(t) {
  return (t || '').split('\n').map(s => s.trim()).filter(Boolean);
}

function buildHtml(report, company, signatureDataUrl) {
  const calc = berechneKalkulation ? berechneKalkulation(report) : null;
  const matLines = linesFrom(report.material);
  const arbLines = linesFrom(report.arbeiten);
  const besLines = linesFrom(report.besonderheiten);
  const mitLines = linesFrom(report.mitarbeiter);
  const fotos = (report.fotos || []).map(buf =>
    'data:image/jpeg;base64,' + (Buffer.isBuffer(buf) ? buf.toString('base64') : buf)
  );

  // Stunden-Tabelle Zeilen
  const stundenRows = ['Monteur', 'Monteur', 'Helfer', 'Helfer'].map((lbl, i) => {
    const name = mitLines[i] ? mitLines[i] : '';
    const isFirst = i === 0;
    const parts = isFirst && report.arbeitszeit ? report.arbeitszeit.split(/[-–]/).map(s => s.trim()) : [];
    return `<tr>
      <td>${lbl}: ${name}</td>
      <td>${isFirst && report.datum ? report.datum : ''}</td>
      <td>${parts[0] || ''}</td>
      <td>${parts[1] || ''}</td>
      <td></td>
    </tr>`;
  }).join('');

  // Material-Zeilen (min 8 Zeilen)
  const matRowCount = Math.max(8, matLines.length + 2);
  let matRows = '';
  for (let i = 0; i < matRowCount; i++) {
    const line = matLines[i] || '';
    // Versuche Menge und Bezeichnung zu trennen
    const match = line.match(/^(\d+[.,]?\d*\s*\w*)\s+(.+)/);
    const menge = match ? match[1] : '';
    const bez = match ? match[2] : line;
    matRows += `<tr>
      <td>${menge}</td>
      <td>${bez}</td>
      <td></td>
      <td></td>
    </tr>`;
  }

  const netto = calc ? calc.netto : '';
  const mwst = calc ? calc.mwst : '';
  const brutto = calc ? calc.brutto : '';

  const firma = company.firma || 'G-Therm Haustechnik';
  const adresse = company.adresse || 'Lindener Str. 111 · 44879 Bochum';
  const telefon = company.telefon || '0234 - 544 618 55';

  const fotoSection = fotos.length > 0 ? `
    <div class="section-title">Fotos</div>
    <div class="foto-grid">
      ${fotos.map(src => `<div class="foto-item"><img src="${src}" /></div>`).join('')}
    </div>
  ` : '';

  const sigSection = signatureDataUrl ? `
    <div class="sig-box signed">
      <div class="sig-label">Auftraggeber / Mieter</div>
      <img class="sig-img" src="${signatureDataUrl}" />
    </div>
  ` : `
    <div class="sig-box">
      <div class="sig-label">Auftraggeber / Mieter</div>
    </div>
  `;

  return `<!DOCTYPE html>
<html lang="de">
<head>
<meta charset="UTF-8">
<style>
  * { margin: 0; padding: 0; box-sizing: border-box; }
  body {
    font-family: Arial, Helvetica, sans-serif;
    font-size: 8.5pt;
    color: #111;
    background: white;
    padding: 0;
  }
  .page { width: 210mm; min-height: 297mm; padding: 8mm 10mm 8mm 10mm; }

  /* HEADER */
  .header {
    background: #1B2A4A;
    color: white;
    display: flex;
    justify-content: space-between;
    align-items: center;
    padding: 8px 12px;
    margin-bottom: 0;
  }
  .header-left {}
  .header-icons { display: flex; gap: 14px; margin-bottom: 4px; }
  .header-icon { text-align: center; font-size: 6.5pt; color: #a0b0cc; }
  .header-icon span { display: block; font-size: 14pt; margin-bottom: 1px; }
  .header-brand { display: flex; align-items: baseline; gap: 4px; }
  .brand-g { font-size: 20pt; font-weight: 900; color: white; letter-spacing: -1px; }
  .brand-therm { font-size: 14pt; font-weight: 700; color: #E8622C; }
  .brand-haus { font-size: 9pt; font-weight: 400; color: #a0b0cc; margin-left: 2px; }
  .header-right { text-align: right; font-size: 8pt; color: #CFD5E3; line-height: 1.6; }
  .header-right .firma-name { font-size: 14pt; font-weight: 800; color: white; display: block; margin-bottom: 2px; }
  .red-bar { background: #C0392B; height: 5px; margin-bottom: 6px; }

  /* TITEL */
  .title-row { display: flex; justify-content: space-between; align-items: baseline; margin-bottom: 6px; }
  .title { font-size: 15pt; font-weight: 800; color: #1B2A4A; }
  .title-date { font-size: 8pt; color: #555; }

  /* TABELLEN allgemein */
  table { width: 100%; border-collapse: collapse; margin-bottom: 5px; }
  td, th { border: 0.5pt solid #2C4A8A; padding: 2px 4px; vertical-align: top; }
  th { background: #1B2A4A; color: white; font-size: 7.5pt; font-weight: 700; text-align: left; padding: 3px 4px; }
  th.center { text-align: center; }
  td.center { text-align: center; }
  tr:nth-child(even) td { background: #F0F3F8; }
  tr:nth-child(odd) td { background: white; }

  /* AUFTRAGGEBER / KUNDE */
  .ag-table th { font-size: 7pt; }
  .ag-table .sub-label { font-size: 6.5pt; color: #1B2A4A; font-weight: 700; display: block; }
  .ag-table td { height: 16px; font-size: 8.5pt; }

  /* STUNDEN */
  .stunden-table th { font-size: 7.5pt; }
  .stunden-table td { height: 14px; }

  /* ARBEITEN */
  .arbeiten-box { border: 0.5pt solid #2C4A8A; padding: 4px 6px; margin-bottom: 5px; min-height: 52px; }
  .box-label { font-size: 7pt; font-weight: 700; color: #1B2A4A; margin-bottom: 2px; }
  .arbeiten-line { font-size: 8.5pt; padding: 1px 0; }
  .arbeiten-line::before { content: "• "; }

  /* MATERIAL */
  .mat-table th:first-child { width: 12%; }
  .mat-table th:last-child, .mat-table th:nth-child(3) { width: 14%; text-align: right; }
  .mat-table td:last-child, .mat-table td:nth-child(3) { text-align: right; }
  .mat-table td { height: 12px; }

  /* SUMMEN */
  .summen-row { display: flex; justify-content: flex-end; gap: 0; margin-top: 3px; margin-bottom: 8px; }
  .summen-label { font-size: 8pt; width: 110px; text-align: right; padding-right: 6px; padding-top: 2px; }
  .summen-line { display: flex; justify-content: flex-end; margin-bottom: 1px; }
  .summen-val { font-size: 8pt; width: 80px; border-bottom: 0.5pt solid #aaa; padding-right: 4px; text-align: right; min-height: 14px; }

  /* UNTERSCHRIFTEN */
  .sig-footer { display: flex; gap: 6px; margin-top: 10px; }
  .sig-box { flex: 1; border: 0.5pt solid #2C4A8A; padding: 4px; min-height: 55px; position: relative; }
  .sig-box.signed { background: #fafafa; }
  .sig-label { font-size: 6.5pt; color: #1B2A4A; font-weight: 700; margin-bottom: 2px; }
  .sig-info { font-size: 6pt; color: #777; margin-top: 18px; border-top: 0.5pt solid #aaa; padding-top: 2px; }
  .sig-img { max-width: 100%; max-height: 45px; display: block; margin-top: 4px; }

  /* FOTOS */
  .section-title { font-size: 8pt; font-weight: 700; color: #1B2A4A; margin: 5px 0 3px 0; }
  .foto-grid { display: flex; flex-wrap: wrap; gap: 4px; margin-bottom: 6px; }
  .foto-item { width: 90px; height: 68px; overflow: hidden; border: 0.5pt solid #ccc; }
  .foto-item img { width: 100%; height: 100%; object-fit: cover; }

  /* ZEUGNIS/STATUS checkboxen rechts */
  .status-box { border: 0.5pt solid #2C4A8A; padding: 3px 5px; font-size: 7pt; line-height: 1.7; }
  .check-row { display: flex; align-items: center; gap: 4px; }
  .checkbox { width: 8px; height: 8px; border: 0.5pt solid #555; display: inline-block; flex-shrink: 0; }
</style>
</head>
<body>
<div class="page">

  <!-- HEADER -->
  <div class="header">
    <div class="header-left">
      <div class="header-icons">
        <div class="header-icon"><span>🔥</span>HEIZUNG</div>
        <div class="header-icon"><span>💧</span>SANITÄR</div>
        <div class="header-icon"><span>💨</span>LÜFTUNG</div>
      </div>
    </div>
    <div class="header-right">
      <span class="firma-name">G-THERM HAUSTECHNIK</span>
      ${adresse}<br>
      Telefon: ${telefon}
    </div>
  </div>
  <div class="red-bar"></div>

  <!-- TITEL -->
  <div class="title-row">
    <span class="title">Auftrags- &amp; Stundenzettel</span>
    <span class="title-date">Datum: ${report.datum || todayStr()}</span>
  </div>

  <!-- AUFTRAGGEBER / KUNDE Tabelle -->
  <table class="ag-table">
    <thead>
      <tr>
        <th style="width:35%">Auftraggeber / Rechnungsempfänger</th>
        <th style="width:8%">Kunden Nr.</th>
        <th style="width:35%">Kunde / Einsatzort</th>
        <th style="width:22%" rowspan="5">
          <div class="status-box">
            <div class="check-row"><div class="checkbox"></div> Reparatur</div>
            <div class="check-row"><div class="checkbox"></div> Wartung</div>
            <div class="check-row"><div class="checkbox"></div> Leistung</div>
            <div class="check-row"><div class="checkbox"></div> Installation</div>
            <div class="check-row"><div class="checkbox"></div> Reinigung</div>
            <div class="check-row"><div class="checkbox"></div> Rohrbau</div>
            <div class="check-row"><div class="checkbox"></div> Neuanlage</div>
            <div class="check-row"><div class="checkbox"></div> Fertigmontage</div>
            <hr style="margin:2px 0;border-color:#aaa">
            <div class="check-row"><div class="checkbox"></div> Arbeit abgeschlossen</div>
            <div class="check-row"><div class="checkbox"></div> Weiterer Besuch erforderlich</div>
            <hr style="margin:2px 0;border-color:#aaa">
            <div style="font-size:6.5pt">An- / Abfahrt: ______ km</div>
            <div style="font-size:6.5pt">Notdienst: ______ Uhr</div>
          </div>
        </th>
      </tr>
    </thead>
    <tbody>
      <tr>
        <td><span class="sub-label">Vorname / Name</span></td>
        <td><span class="sub-label">Referenz</span>${report.referenz || ''}</td>
        <td><span class="sub-label">Vorname / Name</span>${report.kunde || ''}</td>
      </tr>
      <tr>
        <td><span class="sub-label">Straße / Nr.</span></td>
        <td><span class="sub-label">Mitarbeiter</span>${mitLines.join(', ')}</td>
        <td><span class="sub-label">Straße / Nr.</span></td>
      </tr>
      <tr>
        <td><span class="sub-label">PLZ / Ort</span></td>
        <td><span class="sub-label">Arbeitszeit</span>${report.arbeitszeit || ''}</td>
        <td><span class="sub-label">PLZ / Ort</span></td>
      </tr>
      <tr>
        <td><span class="sub-label">Tel. erreichbar</span></td>
        <td></td>
        <td><span class="sub-label">Tel. erreichbar</span></td>
      </tr>
    </tbody>
  </table>

  <!-- STUNDEN-TABELLE -->
  <table class="stunden-table">
    <thead>
      <tr>
        <th style="width:40%">Monteur / Helfer</th>
        <th class="center" style="width:18%">Datum</th>
        <th class="center" style="width:14%">Von</th>
        <th class="center" style="width:14%">Bis</th>
        <th class="center" style="width:14%">Gesamt Std.</th>
      </tr>
    </thead>
    <tbody>
      ${stundenRows}
    </tbody>
  </table>

  <!-- DURCHGEFÜHRTE ARBEITEN -->
  <div class="arbeiten-box">
    <div class="box-label">Auszuführende Arbeit:</div>
    ${arbLines.map(l => `<div class="arbeiten-line">${l}</div>`).join('')}
    ${besLines.length > 0 ? `<div style="margin-top:4px;font-size:7.5pt;color:#555;font-style:italic">Besonderheiten: ${besLines.join(' | ')}</div>` : ''}
  </div>

  <!-- MATERIAL-TABELLE -->
  <table class="mat-table">
    <thead>
      <tr>
        <th>Menge</th>
        <th>Materialverbrauch / Bezeichnung</th>
        <th class="center">Einzel-Preis</th>
        <th class="center">Gesamt-Preis</th>
      </tr>
    </thead>
    <tbody>
      ${matRows}
    </tbody>
  </table>

  <!-- SUMMEN -->
  <div style="text-align:right; font-size:8pt; margin-bottom:6px;">
    <div class="summen-line">
      <span class="summen-label">Nettosumme</span>
      <span class="summen-val">${netto || ''}</span>
    </div>
    <div class="summen-line">
      <span class="summen-label">+ MwSt. _______ %</span>
      <span class="summen-val">${mwst || ''}</span>
    </div>
    <div class="summen-line">
      <span class="summen-label" style="font-weight:700">Bruttosumme</span>
      <span class="summen-val" style="font-weight:700;border-bottom:1pt solid #111">${brutto || ''}</span>
    </div>
  </div>

  <div style="font-size:7.5pt;color:#333;margin-bottom:6px;">
    Zeit und Materialverbrauch anerkannt. Reparatur richtig ausgeführt.
  </div>

  ${fotoSection}

  <!-- UNTERSCHRIFTEN -->
  <div class="sig-footer">
    <div class="sig-box">
      <div class="sig-label">Auftragnehmer</div>
      <div class="sig-info">Datum / Unterschrift</div>
    </div>
    ${sigSection}
    <div class="sig-box">
      <div class="sig-label">Bauführer</div>
      <div class="sig-info">Datum / Unterschrift</div>
    </div>
  </div>

</div>
</body>
</html>`;
}

async function generateReportPdfBuffer(report, company, signatureDataUrl) {
  const html = buildHtml(report, company, signatureDataUrl);

  const browser = await puppeteer.launch({
    headless: true,
    args: [
      '--no-sandbox',
      '--disable-setuid-sandbox',
      '--disable-dev-shm-usage',
      '--disable-gpu',
      '--no-first-run',
      '--no-zygote',
      '--single-process'
    ]
  });

  try {
    const page = await browser.newPage();
    await page.setContent(html, { waitUntil: 'networkidle0' });
    const pdfBuffer = await page.pdf({
      format: 'A4',
      printBackground: true,
      margin: { top: '0', right: '0', bottom: '0', left: '0' }
    });
    return pdfBuffer;
  } finally {
    await browser.close();
  }
}

module.exports = { generateReportPdfBuffer };
