const PDFDocument = require('pdfkit');
const { todayStr } = require('./util');
const { berechneKalkulation } = require('./kalkulation');

// Farben
const NAVY  = '#1B2A4A';
const RED   = '#C0392B';
const BLUE  = '#2C4A8A';
const LGRAY = '#F0F3F8';
const MGRAY = '#C8D4E8';
const BLACK = '#111111';
const GRAY  = '#555555';
const WHITE = '#FFFFFF';

function linesFrom(t) {
  return (t||'').split('\n').map(s=>s.trim()).filter(Boolean);
}

// Zeichne eine einfache horizontale Linie
function hl(doc, x1, y, x2, col, lw) {
  doc.save().moveTo(x1,y).lineTo(x2,y)
     .strokeColor(col||BLUE).lineWidth(lw||0.5).stroke().restore();
}
// Zeichne eine vertikale Linie
function vl(doc, x, y1, y2, col, lw) {
  doc.save().moveTo(x,y1).lineTo(x,y2)
     .strokeColor(col||BLUE).lineWidth(lw||0.5).stroke().restore();
}
// Rechteck mit optionalem Fill und/oder Stroke
function box(doc, x, y, w, h, fill, stroke, lw) {
  if (fill)   { doc.save().rect(x,y,w,h).fillColor(fill).fill().restore(); }
  if (stroke) { doc.save().rect(x,y,w,h).strokeColor(stroke).lineWidth(lw||0.5).stroke().restore(); }
}
// Kleines Label + Wert in einer Zelle
function cell(doc, x, y, w, h, label, value, opts) {
  const fs = (opts&&opts.fs)||8;
  const bold = opts&&opts.bold;
  // Label klein oben
  doc.save().fillColor(NAVY).font('Helvetica').fontSize(6)
     .text(label, x+2, y+2, {width:w-4, lineBreak:false}).restore();
  // Wert
  if (value!==undefined && value!==null && value!=='') {
    doc.save().fillColor(BLACK).font(bold?'Helvetica-Bold':'Helvetica').fontSize(fs)
       .text(String(value), x+3, y+10, {width:w-6, lineBreak:false}).restore();
  }
}

function generateReportPdfBuffer(report, company, signatureDataUrl) {
  return new Promise((resolve, reject) => {
    // A4 ohne margins – wir zeichnen alles manuell
    const doc = new PDFDocument({ size:'A4', margin:0, autoFirstPage:true });
    const bufs = [];
    doc.on('data', c => bufs.push(c));
    doc.on('end',  () => resolve(Buffer.concat(bufs)));
    doc.on('error', reject);

    const PW = 595;   // A4 Breite in Punkten
    const L  = 25;    // linker Rand
    const R  = 570;   // rechter Rand
    const W  = R - L; // Nutzbreite = 545

    // ================================================================
    // HEADER
    // ================================================================
    box(doc, 0, 0, PW, 58, NAVY);

    // Firma links
    doc.save()
       .fillColor(WHITE).font('Helvetica-Bold').fontSize(16)
       .text('G-THERM', L, 12)
       .restore();
    doc.save()
       .fillColor(RED).font('Helvetica-Bold').fontSize(16)
       .text('HAUSTECHNIK', L+72, 12)
       .restore();
    doc.save()
       .fillColor(MGRAY).font('Helvetica').fontSize(7)
       .text('HEIZUNG  ·  SANITÄR  ·  LÜFTUNG', L, 32)
       .restore();

    // Adresse rechts
    const adr = company.adresse || 'Lindener Str. 111 · 44879 Bochum';
    const tel = company.telefon  || '0234 - 544 618 55';
    doc.save()
       .fillColor(WHITE).font('Helvetica').fontSize(7.5)
       .text(adr, 320, 13, {width:245, align:'right'})
       .text('Tel: '+tel, 320, 24, {width:245, align:'right'})
       .restore();

    // Roter Akzentbalken unten am Header
    box(doc, 0, 52, PW, 6, RED);

    // ================================================================
    // TITEL
    // ================================================================
    let y = 72;
    doc.save()
       .fillColor(NAVY).font('Helvetica-Bold').fontSize(15)
       .text('Auftrags- & Stundenzettel', L, y)
       .restore();

    // Datum rechts
    doc.save()
       .fillColor(GRAY).font('Helvetica').fontSize(8.5)
       .text('Datum: ' + (report.datum||todayStr()), 400, y+3, {width:170, align:'right'})
       .restore();

    y += 20;
    hl(doc, L, y, R, NAVY, 1);
    y += 8;

    // ================================================================
    // BLOCK 1: AUFTRAGGEBER / KUNDE (2 Spalten + Checkboxen)
    // ================================================================
    const B1H = 22;  // Zeilenhöhe
    const C1  = L;
    const C2  = L + W*0.48;
    const C3  = L + W*0.80;
    const CW1 = W*0.47;
    const CW2 = W*0.31;
    const CW3 = W*0.20;

    // Header-Zeile
    box(doc, C1, y, CW1, B1H-2, LGRAY, BLUE);
    box(doc, C2, y, CW2, B1H-2, LGRAY, BLUE);
    box(doc, C3, y, CW3, B1H-2, LGRAY, BLUE);
    doc.save().fillColor(NAVY).font('Helvetica-Bold').fontSize(7)
       .text('Auftraggeber / Rechnungsempfänger', C1+3, y+6, {width:CW1-6, lineBreak:false})
       .restore();
    doc.save().fillColor(NAVY).font('Helvetica-Bold').fontSize(7)
       .text('Kunde / Einsatzort', C2+3, y+6, {width:CW2-6, lineBreak:false})
       .restore();
    doc.save().fillColor(NAVY).font('Helvetica-Bold').fontSize(7)
       .text('Kunden-Nr.', C3+3, y+6, {width:CW3-6, lineBreak:false})
       .restore();
    y += B1H - 2;

    // Vorname / Name Zeile
    box(doc, C1, y, CW1, B1H, null, BLUE);
    box(doc, C2, y, CW2, B1H, null, BLUE);
    box(doc, C3, y, CW3, B1H, null, BLUE);
    cell(doc, C1, y, CW1, B1H, 'Vorname / Name', '', {fs:9});
    cell(doc, C2, y, CW2, B1H, 'Vorname / Name', report.kunde||'', {fs:9,bold:true});
    cell(doc, C3, y, CW3, B1H, '', report.referenz||'', {fs:9});
    y += B1H;

    // Straße / Nr.
    box(doc, C1, y, CW1, B1H, null, BLUE);
    box(doc, C2, y, CW2, B1H, null, BLUE);
    box(doc, C3, y, CW3, B1H, null, BLUE);
    cell(doc, C1, y, CW1, B1H, 'Straße / Nr.', '', {});
    cell(doc, C2, y, CW2, B1H, 'Straße / Nr.', '', {});
    cell(doc, C3, y, CW3, B1H, 'Mitarbeiter', linesFrom(report.mitarbeiter).join(', '), {fs:8});
    y += B1H;

    // PLZ / Ort
    box(doc, C1, y, CW1, B1H, null, BLUE);
    box(doc, C2, y, CW2, B1H, null, BLUE);
    box(doc, C3, y, CW3, B1H, null, BLUE);
    cell(doc, C1, y, CW1, B1H, 'PLZ / Ort', '', {});
    cell(doc, C2, y, CW2, B1H, 'PLZ / Ort', '', {});
    cell(doc, C3, y, CW3, B1H, 'Arbeitszeit', report.arbeitszeit||'', {fs:8});
    y += B1H;

    y += 8;

    // ================================================================
    // BLOCK 2: STUNDENNACHWEIS-TABELLE
    // ================================================================
    // Spalten: Name (180) | Datum (80) | Von (70) | Bis (70) | Gesamt (80) | Unterschrift (65)
    const ST = [L, L+180, L+260, L+330, L+400, L+480];
    const STW = [180, 80, 70, 70, 80, W-(480)];
    const STH  = 13;

    // Header
    box(doc, L, y, W, STH, NAVY, BLUE);
    ['Monteur / Helfer','Datum','Von','Bis','Gesamt Std.','✓'].forEach((h,i)=>{
      doc.save().fillColor(WHITE).font('Helvetica-Bold').fontSize(7)
         .text(h, ST[i]+2, y+3, {width:STW[i]-4, align:i>0?'center':'left', lineBreak:false})
         .restore();
    });
    y += STH;

    // Zeilen füllen
    const mitListe = linesFrom(report.mitarbeiter);
    const rowLabels = ['Monteur','Monteur','Helfer','Helfer'];
    rowLabels.forEach((lbl, i) => {
      const bg = i%2===0 ? null : LGRAY;
      box(doc, L, y, W, STH, bg, BLUE, 0.4);
      ST.slice(1).forEach(x => vl(doc, x, y, y+STH, BLUE, 0.4));

      const name = mitListe[i] ? lbl+': '+mitListe[i] : lbl+':';
      doc.save().fillColor(BLACK).font('Helvetica').fontSize(8)
         .text(name, ST[0]+3, y+3, {width:STW[0]-6, lineBreak:false}).restore();

      if (i===0 && report.datum) {
        doc.save().fillColor(BLACK).font('Helvetica').fontSize(8)
           .text(report.datum, ST[1]+2, y+3, {width:STW[1]-4,align:'center',lineBreak:false}).restore();
        if (report.arbeitszeit) {
          const p = report.arbeitszeit.split(/[-–]/).map(s=>s.trim());
          doc.save().fillColor(BLACK).font('Helvetica').fontSize(8)
             .text(p[0]||'', ST[2]+2, y+3, {width:STW[2]-4,align:'center',lineBreak:false}).restore();
          doc.save().fillColor(BLACK).font('Helvetica').fontSize(8)
             .text(p[1]||'', ST[3]+2, y+3, {width:STW[3]-4,align:'center',lineBreak:false}).restore();
        }
      }
      y += STH;
    });

    y += 6;

    // ================================================================
    // BLOCK 3: DURCHGEFÜHRTE ARBEITEN
    // ================================================================
    const arbLines = linesFrom(report.arbeiten);
    const arbH = Math.max(50, arbLines.length * 12 + 18);
    box(doc, L, y, W, arbH, null, BLUE);
    doc.save().fillColor(NAVY).font('Helvetica-Bold').fontSize(7.5)
       .text('Durchgeführte Arbeiten:', L+3, y+3).restore();

    arbLines.forEach((line, i) => {
      doc.save().fillColor(BLACK).font('Helvetica').fontSize(9)
         .text('•  '+line, L+8, y+14+i*12, {width:W-16, lineBreak:false}).restore();
    });
    y += arbH + 6;

    // Besonderheiten (wenn vorhanden)
    const besLines = linesFrom(report.besonderheiten);
    if (besLines.length) {
      const besH = Math.max(26, besLines.length * 11 + 14);
      box(doc, L, y, W, besH, LGRAY, BLUE);
      doc.save().fillColor(NAVY).font('Helvetica-Bold').fontSize(7.5)
         .text('Besonderheiten / Bemerkungen:', L+3, y+3).restore();
      besLines.forEach((line, i) => {
        doc.save().fillColor(BLACK).font('Helvetica').fontSize(8.5)
           .text(line, L+8, y+13+i*10, {width:W-16, lineBreak:false}).restore();
      });
      y += besH + 6;
    }

    // ================================================================
    // BLOCK 4: MATERIAL-TABELLE
    // ================================================================
    // Spalten: Menge(40) | Bezeichnung(flex) | Einzel(65) | Gesamt(65)
    const M1=L, M2=L+40, M3=R-130, M4=R-65;
    const MW=[40, M3-M2, 65, 65];
    const MH=12;

    // Header
    box(doc, L, y, W, MH, NAVY, BLUE);
    ['Menge','Materialverbrauch / Bezeichnung','Einzel-Preis','Gesamt-Preis'].forEach((h,i)=>{
      const xs=[M1,M2,M3,M4];
      doc.save().fillColor(WHITE).font('Helvetica-Bold').fontSize(7)
         .text(h, xs[i]+2, y+3, {width:MW[i]-4, align:i===0?'left':'center', lineBreak:false}).restore();
    });
    y += MH;

    const matLines = linesFrom(report.material);
    const NUM_ROWS = Math.max(8, matLines.length + 2);

    for (let i=0; i<NUM_ROWS; i++) {
      const bg = i%2===0 ? null : LGRAY;
      box(doc, L, y, W, MH, bg, BLUE, 0.3);
      [M2,M3,M4].forEach(x => vl(doc, x, y, y+MH, BLUE, 0.3));

      if (matLines[i]) {
        const line = matLines[i];
        const mm = line.match(/^(\d+[\s×xX]?(?:Stk?\.?|m|l|kg|St)?)/i);
        let menge='', name=line;
        if (mm) { menge=mm[1].trim(); name=line.slice(mm[1].length).replace(/^[\s·\-]+/,''); }
        doc.save().fillColor(BLACK).font('Helvetica').fontSize(8)
           .text(menge, M1+2, y+2, {width:MW[0]-4, lineBreak:false}).restore();
        doc.save().fillColor(BLACK).font('Helvetica').fontSize(8)
           .text(name,  M2+3, y+2, {width:MW[1]-6, lineBreak:false}).restore();
      }
      y += MH;
    }

    // Summen-Zeilen
    const kalk = berechneKalkulation(report);
    if (kalk) {
      const sumRows = [
        {label:'Nettosumme',   val:kalk.nettoText,   bg:LGRAY},
        {label:`MwSt. ${kalk.mwstSatz}%`, val:kalk.mwstText, bg:LGRAY},
        {label:'Bruttosumme',  val:kalk.bruttoText,  bg:NAVY, white:true},
      ];
      sumRows.forEach(sr => {
        box(doc, L, y, W-130, MH, null, BLUE, 0.3);
        box(doc, M3, y, 65, MH, sr.bg||LGRAY, BLUE, 0.4);
        box(doc, M4, y, 65, MH, sr.bg||LGRAY, BLUE, 0.4);
        doc.save().fillColor(NAVY).font('Helvetica').fontSize(7.5)
           .text(sr.label, M2+3, y+3, {width:130, lineBreak:false}).restore();
        doc.save().fillColor(sr.white?WHITE:BLACK).font('Helvetica-Bold').fontSize(8.5)
           .text(sr.val, M4+2, y+2, {width:61, align:'right', lineBreak:false}).restore();
        y += MH;
      });
    }
    y += 8;

    // ================================================================
    // FOTOS
    // ================================================================
    if (Array.isArray(report.fotos) && report.fotos.length) {
      hl(doc, L, y, R, NAVY, 0.8);
      y += 6;
      doc.save().fillColor(NAVY).font('Helvetica-Bold').fontSize(8)
         .text('Fotodokumentation', L, y).restore();
      y += 14;
      for (const foto of report.fotos) {
        try {
          if (y > 700) { doc.addPage(); y = 30; }
          doc.image(foto, L, y, {fit:[W, 210], align:'center'});
          y += 218;
        } catch(e) {}
      }
      y += 6;
    }

    // ================================================================
    // UNTERSCHRIFTEN-FOOTER
    // ================================================================
    // Sicherstellen dass der Footer auf die Seite passt
    if (y > 770) { doc.addPage(); y = 30; }

    hl(doc, L, y, R, NAVY, 1);
    y += 6;

    // Hinweistext
    doc.save().fillColor(GRAY).font('Helvetica').fontSize(7)
       .text('Zeit und Materialverbrauch anerkannt. Reparatur richtig ausgeführt.', L, y)
       .restore();
    y += 14;

    // 3 Unterschriften-Felder
    const SW = (W-8)/3;
    const sigPositions = [L, L+SW+4, L+2*(SW+4)];
    const sigTitles    = ['Auftragnehmer','Auftraggeber / Mieter','Bauführer'];

    sigPositions.forEach((sx, i) => {
      // Unterschrifts-Box
      box(doc, sx, y, SW, 36, i===1&&signatureDataUrl ? null : LGRAY, BLUE, 0.5);

      // Kunden-Unterschrift einbetten (Feld 2 = Auftraggeber)
      if (i===1 && signatureDataUrl) {
        try {
          const b64 = signatureDataUrl.replace(/^data:image\/\w+;base64,/, '');
          doc.image(Buffer.from(b64,'base64'), sx+4, y+2, {fit:[SW-8,32], align:'center'});
        } catch(e) {}
      }

      // Linie + Label darunter
      hl(doc, sx, y+36, sx+SW, NAVY, 0.8);
      doc.save().fillColor(NAVY).font('Helvetica-Bold').fontSize(7)
         .text(sigTitles[i], sx, y+39, {width:SW, align:'center', lineBreak:false}).restore();
    });

    y += 52;

    if (signatureDataUrl) {
      doc.save().fillColor(GRAY).font('Helvetica').fontSize(6.5)
         .text('Elektronisch unterschrieben am '+todayStr(), L, y, {width:W, align:'center'}).restore();
      y += 10;
    }

    // Seiten-Footer
    hl(doc, L, 822, R, MGRAY, 0.3);
    doc.save().fillColor(GRAY).font('Helvetica').fontSize(6.5)
       .text((company.firma||'G-Therm Haustechnik')+' · '+(company.adresse||'')+' · Tel: '+(company.telefon||''),
             L, 825, {width:W*0.7, lineBreak:false}).restore();
    doc.save().fillColor(GRAY).font('Helvetica').fontSize(6.5)
       .text('Erstellt am '+todayStr(), L+W*0.7, 825, {width:W*0.3, align:'right', lineBreak:false}).restore();

    doc.end();
  });
}

module.exports = { generateReportPdfBuffer };
