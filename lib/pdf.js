const PDFDocument = require('pdfkit');
const { todayStr } = require('./util');
const { berechneKalkulation } = require('./kalkulation');

// ---------------------------------------------------------------
// Farben (angelehnt an originales G-Therm Formblatt)
// ---------------------------------------------------------------
const C = {
  navy:    '#1B2A4A',   // dunkelblaues Header-Blau
  red:     '#C0392B',   // G-Therm Rot/Orange-Rot
  border:  '#2C4A8A',   // Tabellen-Rahmen Blau
  label:   '#1B2A4A',   // Beschriftungen
  light:   '#E8EDF5',   // heller Tabellen-Hintergrund
  mid:     '#B8C8E0',   // mittlere Linien
  text:    '#111111',   // Haupttext
  white:   '#FFFFFF',
  gray:    '#666666',
};

// Hilfsfunktionen
function linesFrom(text) {
  return (text || '').split('\n').map(l => l.trim()).filter(Boolean);
}

function hline(doc, x1, y, x2, color, w) {
  doc.moveTo(x1, y).lineTo(x2, y).strokeColor(color || C.border).lineWidth(w || 0.5).stroke();
}

function vline(doc, x, y1, y2, color, w) {
  doc.moveTo(x, y1).lineTo(x, y2).strokeColor(color || C.border).lineWidth(w || 0.5).stroke();
}

function rect(doc, x, y, w, h, fill, stroke, sw) {
  doc.rect(x, y, w, h);
  if (fill)   doc.fillColor(fill).fill();
  if (stroke) doc.rect(x, y, w, h).strokeColor(stroke).lineWidth(sw || 0.5).stroke();
}

function cellText(doc, x, y, w, h, label, value, opts) {
  const o = opts || {};
  // Beschriftung oben
  doc.fillColor(C.label).font('Helvetica').fontSize(o.labelSize || 6.5)
     .text(label, x + 2, y + 2, { width: w - 4, lineBreak: false });
  // Wert darunter
  if (value !== undefined && value !== null) {
    doc.fillColor(C.text).font(o.bold ? 'Helvetica-Bold' : 'Helvetica').fontSize(o.valSize || 9)
       .text(value, x + 3, y + 11, { width: w - 6, lineBreak: false });
  }
}

// ---------------------------------------------------------------
// Haupt-Export
// ---------------------------------------------------------------
function generateReportPdfBuffer(report, company, signatureDataUrl) {
  return new Promise((resolve, reject) => {
    const doc = new PDFDocument({ size: 'A4', margin: 0, autoFirstPage: true });
    const buffers = [];
    doc.on('data', chunk => buffers.push(chunk));
    doc.on('end',  ()    => resolve(Buffer.concat(buffers)));
    doc.on('error', reject);

    const PW = doc.page.width;   // 595
    const PH = doc.page.height;  // 842
    const L  = 28;               // linker Rand
    const R  = PW - 28;          // rechter Rand
    const CW = R - L;            // Contentbreite ~539

    // ============================================================
    // 1) HEADER-BANNER
    // ============================================================
    const HEADER_H = 52;
    rect(doc, 0, 0, PW, HEADER_H, C.navy, null);

    // Logo-Text links
    doc.fillColor(C.white).font('Helvetica-Bold').fontSize(17)
       .text('G-THERM', L, 10, { continued: true })
       .fillColor(C.red)
       .text(' HAUSTECHNIK');
    doc.fillColor(C.white).font('Helvetica').fontSize(7.5)
       .text('IHR MEISTERBETRIEB', L, 9, { align: 'left', width: 120 });

    // Icons-Leiste
    const icons = ['HEIZUNG', 'SANITAER', 'LUEFTUNG'];
    const iconX = [L, L + 62, L + 128];
    icons.forEach((ic, i) => {
      doc.fillColor(C.mid).font('Helvetica-Bold').fontSize(6.5)
         .text(ic, iconX[i], 38, { width: 58 });
    });

    // Adresse rechts
    const addrX = PW - 200;
    doc.fillColor(C.white).font('Helvetica').fontSize(7.5)
       .text(company.adresse || 'Lindener Str. 111 · 44879 Bochum', addrX, 10, { width: 172, align: 'right' })
       .text(`Telefon: ${company.telefon || '0234 - 544 618 55'}`, addrX, 21, { width: 172, align: 'right' });

    // Titel-Zeile unter Header
    const TITLE_Y = HEADER_H + 6;
    doc.fillColor(C.navy).font('Helvetica-Bold').fontSize(14)
       .text('Auftrags- & Stundenzettel', L, TITLE_Y);

    // Datum/Referenz rechts neben Titel
    doc.fillColor(C.gray).font('Helvetica').fontSize(7.5)
       .text('Datum: ' + (report.datum || todayStr()), PW - 200, TITLE_Y + 2, { width: 172, align: 'right' });

    hline(doc, L, TITLE_Y + 18, R, C.navy, 1);

    // ============================================================
    // 2) AUFTRAGGEBER / EMPFÄNGER BLOCK (2 Spalten + Checkboxen)
    // ============================================================
    let y = TITLE_Y + 22;
    const COL1 = L;
    const COL2 = L + CW * 0.5 + 2;
    const COL_W1 = CW * 0.5 - 2;
    const COL_W2 = CW * 0.38 - 2;
    const CHK_X  = COL2 + COL_W2 + 4;
    const CHK_W  = R - CHK_X;
    const ROW_H  = 22;

    // Spaltenköpfe
    rect(doc, COL1, y, COL_W1, 14, C.light, C.border);
    rect(doc, COL2, y, COL_W2, 14, C.light, C.border);
    rect(doc, CHK_X, y, CHK_W, 14, C.light, C.border);

    doc.fillColor(C.label).font('Helvetica-Bold').fontSize(7)
       .text('Auftraggeber / Rechnungsempfänger', COL1 + 3, y + 3, { width: COL_W1 - 6, lineBreak: false })
       .text('Kunde / Einsatzort',                 COL2 + 3, y + 3, { width: COL_W2 - 6, lineBreak: false })
       .text('',                                    CHK_X  + 3, y + 3, { width: CHK_W  - 6, lineBreak: false });
    y += 14;

    // Kunden-Nr. Zeile
    rect(doc, COL1, y, 55, 14, null, C.border);
    rect(doc, COL1 + 55, y, COL_W1 - 55, 14, null, C.border);
    rect(doc, COL2, y, COL_W2, 14, null, C.border);
    rect(doc, CHK_X, y, CHK_W, ROW_H * 3, null, C.border);

    doc.fillColor(C.label).font('Helvetica').fontSize(6)
       .text('Kunden Nr.', COL1 + 2, y + 2, { lineBreak: false })
       .text('',           COL1 + 57, y + 2, { lineBreak: false });
    doc.fillColor(C.label).font('Helvetica').fontSize(6)
       .text(report.referenz || '', COL1 + 57, y + 6, { width: COL_W1 - 60, lineBreak: false });

    // Checkboxen rechts
    const chkLabels = [
      ['Reparatur', 'Wartung'],
      ['Leistung',  'Installation'],
      ['Reinigung', 'Rohrbruch'],
      ['Neuanlage', 'Fertigmeldung'],
    ];
    const chkY0 = y + 2;
    chkLabels.forEach((pair, i) => {
      const cy = chkY0 + i * 9.5;
      // Checkbox-Kästchen + Label
      doc.rect(CHK_X + 3, cy, 6, 6).strokeColor(C.border).lineWidth(0.5).stroke();
      doc.fillColor(C.text).font('Helvetica').fontSize(6.5).text(pair[0], CHK_X + 11, cy, { lineBreak: false });
      doc.rect(CHK_X + 50, cy, 6, 6).strokeColor(C.border).lineWidth(0.5).stroke();
      doc.fillColor(C.text).font('Helvetica').fontSize(6.5).text(pair[1], CHK_X + 58, cy, { lineBreak: false });
    });

    y += 14;

    // Vorname/Name Zeilen
    const addrRows = [
      ['Vorname / Name', 'Vorname / Name'],
      ['Strasse / Nr.',  'Strasse / Nr.'],
      ['PLZ / Ort',      'PLZ / Ort'],
      ['Telefon / erreichbar', 'Telefon / erreichbar'],
    ];

    // Auftraggeber-Daten ausfüllen
    const auftraggeberDaten = ['', report.kunde || '', '', ''];
    const einsatzortDaten   = [report.kunde || '', '', '', ''];

    addrRows.forEach((row, i) => {
      const rh = i === 0 ? ROW_H : 18;
      rect(doc, COL1, y, COL_W1, rh, null, C.border);
      rect(doc, COL2, y, COL_W2, rh, null, C.border);

      doc.fillColor(C.label).font('Helvetica').fontSize(6).text(row[0], COL1 + 2, y + 2, { lineBreak: false });
      doc.fillColor(C.label).font('Helvetica').fontSize(6).text(row[1], COL2 + 2, y + 2, { lineBreak: false });

      if (i === 0) {
        // Kundenname prominent
        doc.fillColor(C.text).font('Helvetica-Bold').fontSize(9)
           .text(report.kunde || '', COL1 + 3, y + 10, { width: COL_W1 - 6, lineBreak: false });
        doc.fillColor(C.text).font('Helvetica').fontSize(8)
           .text(report.mitarbeiter || '', COL2 + 3, y + 10, { width: COL_W2 - 6, lineBreak: false });
      }
      y += rh;
    });

    y += 4;

    // ============================================================
    // 3) STUNDEN-TABELLE
    // ============================================================
    const ST_COL = [L, L + 88, L + 88 + 70, L + 88 + 70 + 70, R - 70];
    const ST_W   = [88, 70, 70, ST_COL[4] - ST_COL[3], 70];
    const ST_H   = 14;

    // Header
    rect(doc, L, y, CW, ST_H, C.light, C.border);
    const stHeaders = ['', 'Datum', 'von', 'bis', 'Gesamt Std.'];
    stHeaders.forEach((h, i) => {
      doc.fillColor(C.label).font('Helvetica-Bold').fontSize(7)
         .text(h, ST_COL[i] + 2, y + 4, { width: ST_W[i] - 4, align: i > 0 ? 'center' : 'left', lineBreak: false });
    });
    // Vertikale Linien Header
    ST_COL.slice(1).forEach(x => vline(doc, x, y, y + ST_H));
    hline(doc, L, y + ST_H, R, C.border);
    y += ST_H;

    // Monteur / Helfer Zeilen aus report.mitarbeiter
    const mitarbeiterListe = linesFrom(report.mitarbeiter);
    const rowLabels = ['Monteur:', 'Monteur:', 'Helfer:', 'Helfer:'];
    const stRowH = 16;

    rowLabels.forEach((label, i) => {
      rect(doc, L, y, CW, stRowH, null, C.border);
      ST_COL.slice(1).forEach(x => vline(doc, x, y, y + stRowH));

      doc.fillColor(C.label).font('Helvetica').fontSize(7.5)
         .text(label, L + 3, y + 4, { width: ST_W[0] - 6, lineBreak: false });

      // Mitarbeiter-Name in erste Spalte
      if (mitarbeiterListe[i]) {
        doc.fillColor(C.text).font('Helvetica').fontSize(8)
           .text(mitarbeiterListe[i] || '', L + 50, y + 4, { width: 35, lineBreak: false });
      }
      // Arbeitszeit in Datum/Von/Bis
      if (i === 0 && report.datum) {
        doc.fillColor(C.text).font('Helvetica').fontSize(8)
           .text(report.datum, ST_COL[1] + 2, y + 4, { width: ST_W[1] - 4, align: 'center', lineBreak: false });
        if (report.arbeitszeit) {
          const parts = report.arbeitszeit.split('-').map(s => s.trim());
          doc.text(parts[0] || '', ST_COL[2] + 2, y + 4, { width: ST_W[2] - 4, align: 'center', lineBreak: false });
          doc.text(parts[1] || '', ST_COL[3] + 2, y + 4, { width: ST_W[3] - 4, align: 'center', lineBreak: false });
        }
      }
      y += stRowH;
    });

    // "Ausführende Arbeit" Großfeld
    const ARBEIT_H = 50;
    rect(doc, L, y, CW, ARBEIT_H, null, C.border);
    doc.fillColor(C.label).font('Helvetica').fontSize(7).text('Ausfuehrende Arbeit:', L + 3, y + 3);
    const arbeitenLines = linesFrom(report.arbeiten);
    doc.fillColor(C.text).font('Helvetica').fontSize(8);
    arbeitenLines.slice(0, 4).forEach((line, i) => {
      doc.text('• ' + line, L + 5, y + 13 + i * 10, { width: CW - 10, lineBreak: false });
    });
    y += ARBEIT_H + 4;

    // Besonderheiten (wenn vorhanden)
    if (report.besonderheiten && report.besonderheiten.trim()) {
      const BESH = 28;
      rect(doc, L, y, CW, BESH, null, C.border);
      doc.fillColor(C.label).font('Helvetica').fontSize(7).text('Besonderheiten / Bemerkungen:', L + 3, y + 3);
      doc.fillColor(C.text).font('Helvetica').fontSize(8)
         .text(report.besonderheiten, L + 5, y + 13, { width: CW - 10, lineBreak: false });
      y += BESH + 4;
    }

    y += 4;

    // ============================================================
    // 4) MATERIAL-TABELLE
    // ============================================================
    const MAT_COLS = [L, L + 35, L + 35 + CW * 0.62, R - 55];
    const MAT_WIDTHS = [35, CW * 0.62, 55, 55];
    const MAT_H = 13;

    // Material-Header
    rect(doc, L, y, CW, MAT_H, C.light, C.border);
    const matHeaders = ['Menge', 'Materialverbrauch', 'Einzel-Preis', 'Gesamt-Preis'];
    matHeaders.forEach((h, i) => {
      doc.fillColor(C.label).font('Helvetica-Bold').fontSize(7)
         .text(h, MAT_COLS[i] + 2, y + 3, { width: MAT_WIDTHS[i] - 4, align: i === 0 ? 'left' : 'center', lineBreak: false });
    });
    MAT_COLS.slice(1).forEach(x => vline(doc, x, y, y + MAT_H));
    hline(doc, L, y + MAT_H, R, C.border);
    y += MAT_H;

    // Material-Zeilen
    const materialLines = linesFrom(report.material);
    const NUM_MAT_ROWS = Math.max(8, materialLines.length + 2);
    for (let i = 0; i < NUM_MAT_ROWS; i++) {
      rect(doc, L, y, CW, MAT_H, i % 2 === 0 ? null : '#F7F9FC', C.border, 0.3);
      MAT_COLS.slice(1).forEach(x => vline(doc, x, y, y + MAT_H, C.border, 0.3));

      if (materialLines[i]) {
        // Versuche Menge zu extrahieren (z.B. "3x Dichtung" oder "2 Stk ...")
        const line = materialLines[i];
        const mengeMatch = line.match(/^(\d+[x×]?\s*Stk?\.?|\d+\s*m|\d+\s*l|\d+)/i);
        let menge = '';
        let matName = line;
        if (mengeMatch) {
          menge = mengeMatch[0].trim();
          matName = line.replace(mengeMatch[0], '').trim();
        }
        doc.fillColor(C.text).font('Helvetica').fontSize(7.5)
           .text(menge,   MAT_COLS[0] + 2, y + 3, { width: MAT_WIDTHS[0] - 4, lineBreak: false })
           .text(matName, MAT_COLS[1] + 2, y + 3, { width: MAT_WIDTHS[1] - 4, lineBreak: false });
      }
      y += MAT_H;
    }

    // Summen-Zeilen am Ende der Materialtabelle
    const kalk = berechneKalkulation(report);
    if (kalk) {
      const SUM_H = 14;
      // Nettosumme
      rect(doc, L, y, CW - 80, SUM_H, null, C.border, 0.3);
      rect(doc, R - 80, y, 80, SUM_H, C.light, C.border);
      MAT_COLS.slice(1).forEach(x => vline(doc, x, y, y + SUM_H, C.border, 0.3));
      doc.fillColor(C.label).font('Helvetica').fontSize(7)
         .text('Nettosumme', MAT_COLS[1] + 2, y + 4, { width: 120, lineBreak: false });
      doc.fillColor(C.text).font('Helvetica-Bold').fontSize(8)
         .text(kalk.nettoText, R - 78, y + 4, { width: 76, align: 'right', lineBreak: false });
      y += SUM_H;

      // MwSt.
      rect(doc, L, y, CW - 80, SUM_H, null, C.border, 0.3);
      rect(doc, R - 80, y, 80, SUM_H, C.light, C.border);
      MAT_COLS.slice(1).forEach(x => vline(doc, x, y, y + SUM_H, C.border, 0.3));
      doc.fillColor(C.label).font('Helvetica').fontSize(7)
         .text(`+ MwSt. ${kalk.mwstSatz} %`, MAT_COLS[1] + 2, y + 4, { width: 120, lineBreak: false });
      doc.fillColor(C.text).font('Helvetica').fontSize(8)
         .text(kalk.mwstText, R - 78, y + 4, { width: 76, align: 'right', lineBreak: false });
      y += SUM_H;

      // Bruttosumme
      rect(doc, L, y, CW - 80, SUM_H, null, C.border, 0.3);
      rect(doc, R - 80, y, 80, C.navy, C.navy);
      MAT_COLS.slice(1).forEach(x => vline(doc, x, y, y + SUM_H, C.border, 0.3));
      doc.fillColor(C.label).font('Helvetica-Bold').fontSize(7)
         .text('Bruttosumme', MAT_COLS[1] + 2, y + 4, { width: 120, lineBreak: false });
      doc.fillColor(C.white).font('Helvetica-Bold').fontSize(9)
         .text(kalk.bruttoText, R - 78, y + 4, { width: 76, align: 'right', lineBreak: false });
      y += SUM_H;
    }

    y += 6;

    // ============================================================
    // 5) FOTOS (auf neuer Seite wenn nötig)
    // ============================================================
    if (Array.isArray(report.fotos) && report.fotos.length) {
      if (y > PH - 200) { doc.addPage(); y = 30; }

      hline(doc, L, y, R, C.border, 0.5);
      y += 4;
      doc.fillColor(C.label).font('Helvetica-Bold').fontSize(8)
         .text('FOTODOKUMENTATION', L, y);
      y += 14;

      for (const foto of report.fotos) {
        try {
          if (y > PH - 180) { doc.addPage(); y = 30; }
          doc.image(foto, L, y, { fit: [CW, 220], align: 'center' });
          y += 230;
        } catch (e) { /* Bild überspringen */ }
      }
      y += 4;
    }

    // ============================================================
    // 6) UNTERSCHRIFTEN-FOOTER
    // ============================================================
    // Sicherstellen dass Footer auf die Seite passt
    const FOOTER_H = 70;
    if (y > PH - FOOTER_H - 10) { doc.addPage(); y = 30; }

    // Trennlinie
    hline(doc, L, y, R, C.navy, 0.8);
    y += 5;

    // Hinweistext
    doc.fillColor(C.gray).font('Helvetica').fontSize(7)
       .text('Zeit und Materialverbrauch anerkannt. Reparatur richtig ausgefuehrt.', L, y);
    y += 12;

    // Unterschrift-Felder
    const sigW = (CW - 6) / 3;
    const sigLabels = ['Auftragnehmer', 'Auftraggeber / Mieter', 'Baufuehrer'];
    const sigY1 = y;
    const sigLineY = y + 32;

    sigLabels.forEach((label, i) => {
      const sx = L + i * (sigW + 3);

      // Unterschrift-Bild einbetten (nur erstes Feld = Auftraggeber-Unterschrift)
      if (i === 1 && signatureDataUrl) {
        try {
          const b64 = signatureDataUrl.replace(/^data:image\/\w+;base64,/, '');
          const sigBuf = Buffer.from(b64, 'base64');
          doc.image(sigBuf, sx + 2, sigY1 + 2, { fit: [sigW - 4, 28], align: 'center' });
        } catch (e) { /* ignore */ }
      }

      // Unterschriften-Linie
      hline(doc, sx, sigLineY, sx + sigW, C.navy, 0.8);

      // Label unter Linie
      doc.fillColor(C.navy).font('Helvetica-Bold').fontSize(7)
         .text(label, sx, sigLineY + 3, { width: sigW, align: 'center', lineBreak: false });
    });

    if (signatureDataUrl) {
      y = sigLineY + 16;
      doc.fillColor(C.gray).font('Helvetica').fontSize(6.5)
         .text(`Elektronisch unterschrieben am ${todayStr()}`, L, y, { width: CW, align: 'center' });
      y += 8;
    }

    y = sigLineY + 16;

    // Seiten-Footer
    const pageFooterY = PH - 20;
    hline(doc, L, pageFooterY - 3, R, C.mid, 0.3);
    doc.fillColor(C.gray).font('Helvetica').fontSize(6.5)
       .text(`${company.firma || 'G-Therm Haustechnik'} · ${company.adresse || ''} · Tel: ${company.telefon || ''}`,
             L, pageFooterY, { width: CW * 0.7, lineBreak: false });
    doc.text(`Erstellt am ${todayStr()}`,
             L + CW * 0.7, pageFooterY, { width: CW * 0.3, align: 'right', lineBreak: false });

    doc.end();
  });
}

module.exports = { generateReportPdfBuffer };
