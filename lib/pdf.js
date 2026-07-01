const PDFDocument = require('pdfkit');
const { todayStr } = require('./util');
const { berechneKalkulation } = require('./kalkulation');

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

function hl(doc, x1, y, x2, col, lw) {
  doc.save().moveTo(x1,y).lineTo(x2,y).strokeColor(col||BLUE).lineWidth(lw||0.5).stroke().restore();
}
function vl(doc, x, y1, y2, col, lw) {
  doc.save().moveTo(x,y1).lineTo(x,y2).strokeColor(col||BLUE).lineWidth(lw||0.5).stroke().restore();
}
function box(doc, x, y, w, h, fill, stroke, lw) {
  if (fill)   { doc.save().rect(x,y,w,h).fillColor(fill).fill().restore(); }
  if (stroke) { doc.save().rect(x,y,w,h).strokeColor(stroke).lineWidth(lw||0.5).stroke().restore(); }
}
function cell(doc, x, y, w, h, label, value, opts) {
  const fs = (opts&&opts.fs)||8;
  const bold = opts&&opts.bold;
  doc.save().fillColor(NAVY).font('Helvetica').fontSize(6)
     .text(label, x+2, y+2, {width:w-4, lineBreak:false}).restore();
  if (value!==undefined && value!==null && value!=='') {
    doc.save().fillColor(BLACK).font(bold?'Helvetica-Bold':'Helvetica').fontSize(fs)
       .text(String(value), x+3, y+10, {width:w-6, lineBreak:false}).restore();
  }
}

function generateReportPdfBuffer(report, company, signatureDataUrl) {
  return new Promise((resolve, reject) => {
    const doc = new PDFDocument({ size:'A4', margin:0, autoFirstPage:true });
    const bufs = [];
    doc.on('data', c => bufs.push(c));
    doc.on('end',  () => resolve(Buffer.concat(bufs)));
    doc.on('error', reject);

    const PW = 595;
    const L  = 25;
    const R  = 570;
    const W  = R - L;

    // HEADER
    box(doc, 0, 0, PW, 58, NAVY);
    doc.save().fillColor(WHITE).font('Helvetica-Bold').fontSize(16).text('G-THERM', L, 12).restore();
    doc.save().fillColor(RED).font('Helvetica-Bold').fontSize(16).text('HAUSTECHNIK', L+72, 12).restore();
    doc.save().fillColor(MGRAY).font('Helvetica').fontSize(7).text('HEIZUNG  ·  SANITÄR  ·  LÜFTUNG', L, 32).restore();
    const adr = company.adresse || 'Lindener Str. 111 · 44879 Bochum';
    const tel = company.telefon  || '0234 - 544 618 55';
    doc.save().fillColor(WHITE).font('Helvetica').fontSize(7.5)
       .text(adr, 320, 13, {width:245, align:'right'})
       .text('Tel: '+tel, 320, 24, {width:245, align:'right'}).restore();
    box(doc, 0, 52, PW, 6, RED);

    // TITEL
    let y = 72;
    doc.save().fillColor(NAVY).font('Helvetica-Bold').fontSize(15).text('Auftrags- & Stundenzettel', L, y).restore();
    doc.save().fillColor(GRAY).font('Helvetica').fontSize(8.5)
       .text('Datum: '+(report.datum||todayStr()), 400, y+3, {width:170, align:'right'}).restore();
    y += 20;
    hl(doc, L, y, R, NAVY, 1);
    y += 8;

    // AUFTRAGGEBER / KUNDE
    const B1H = 22;
    const C1=L, C2=L+W*0.48, C3=L+W*0.80;
    const CW1=W*0.47, CW2=W*0.31, CW3=W*0.20;

    // Header-Zeile
    box(doc,C1,y,CW1,B1H-2,LGRAY,BLUE); box(doc,C2,y,CW2,B1H-2,LGRAY,BLUE); box(doc,C3,y,CW3,B1H-2,LGRAY,BLUE);
    doc.save().fillColor(NAVY).font('Helvetica-Bold').fontSize(7)
       .text('Auftraggeber / Rechnungsempfänger', C1+3, y+6, {width:CW1-6, lineBreak:false})
       .text('Kunde / Einsatzort', C2+3, y+6, {width:CW2-6, lineBreak:false})
       .text('Kunden-Nr.', C3+3, y+6, {width:CW3-6, lineBreak:false}).restore();
    y += B1H-2;

    // Zeilen
    const addrRows = [
      ['Vorname / Name', 'Vorname / Name', 'Referenz'],
      ['Straße / Nr.',   'Straße / Nr.',   'Mitarbeiter'],
      ['PLZ / Ort',      'PLZ / Ort',      'Arbeitszeit'],
      ['Tel. erreichbar','Tel. erreichbar', ''],
    ];
    const vals1 = ['','','',''];
    const vals2 = [report.kunde||'','','',''];
    const vals3 = [report.referenz||'', linesFrom(report.mitarbeiter).join(', '), report.arbeitszeit||'', ''];

    addrRows.forEach((row, i) => {
      box(doc,C1,y,CW1,B1H,null,BLUE); box(doc,C2,y,CW2,B1H,null,BLUE); box(doc,C3,y,CW3,B1H,null,BLUE);
      cell(doc,C1,y,CW1,B1H, row[0], vals1[i], {fs:9, bold:false});
      cell(doc,C2,y,CW2,B1H, row[1], vals2[i], {fs:9, bold:i===0});
      cell(doc,C3,y,CW3,B1H, row[2], vals3[i], {fs:8});
      y += B1H;
    });
    y += 8;

    // STUNDENNACHWEIS-TABELLE
    const ST=[L, L+185, L+265, L+335, L+405, L+480];
    const STW=[185, 80, 70, 70, 75, W-480+L-L];
    const STH=13;

    box(doc, L, y, W, STH, NAVY, BLUE);
    ['Monteur / Helfer','Datum','Von','Bis','Gesamt Std.',''].forEach((h,i)=>{
      doc.save().fillColor(WHITE).font('Helvetica-Bold').fontSize(7)
         .text(h, ST[i]+2, y+3, {width:STW[i]-4, align:i>0?'center':'left', lineBreak:false}).restore();
    });
    y += STH;

    const mitListe = linesFrom(report.mitarbeiter);
    ['Monteur','Monteur','Helfer','Helfer'].forEach((lbl, i) => {
      box(doc,L,y,W,STH,i%2===0?null:LGRAY,BLUE,0.4);
      ST.slice(1).forEach(x=>vl(doc,x,y,y+STH,BLUE,0.4));
      const name = mitListe[i] ? lbl+': '+mitListe[i] : lbl+':';
      doc.save().fillColor(BLACK).font('Helvetica').fontSize(8)
         .text(name, ST[0]+3, y+3, {width:STW[0]-6, lineBreak:false}).restore();
      if (i===0 && report.datum) {
        doc.save().fillColor(BLACK).font('Helvetica').fontSize(8)
           .text(report.datum, ST[1]+2, y+3, {width:STW[1]-4, align:'center', lineBreak:false}).restore();
        if (report.arbeitszeit) {
          const p = report.arbeitszeit.split(/[-–]/).map(s=>s.trim());
          doc.save().fillColor(BLACK).font('Helvetica').fontSize(8)
             .text(p[0]||'', ST[2]+2, y+3, {width:STW[2]-4, align:'center', lineBreak:false}).restore();
          doc.save().fillColor(BLACK).font('Helvetica').fontSize(8)
             .text(p[1]||'', ST[3]+2, y+3, {width:STW[3]-4, align:'center', lineBreak:false}).restore();
        }
      }
      y += STH;
    });
    y += 6;

    // DURCHGEFÜHRTE ARBEITEN
    const arbLines = linesFrom(report.arbeiten);
    const arbH = Math.max(52, arbLines.length*12+20);
    box(doc, L, y, W, arbH, null, BLUE);
    doc.save().fillColor(NAVY).font('Helvetica-Bold').fontSize(7.5).text('Durchgeführte Arbeiten:', L+3, y+3).restore();
    arbLines.forEach((line, i) => {
      doc.save().fillColor(BLACK).font('Helvetica').fontSize(9)
         .text('•  '+line, L+8, y+14+i*12, {width:W-16, lineBreak:false}).restore();
    });
    y += arbH+6;

    const besLines = linesFrom(report.besonderheiten);
    if (besLines.length) {
      const besH = Math.max(28, besLines.length*11+16);
      box(doc, L, y, W, besH, LGRAY, BLUE);
      doc.save().fillColor(NAVY).font('Helvetica-Bold').fontSize(7.5).text('Besonderheiten:', L+3, y+3).restore();
      besLines.forEach((line, i) => {
        doc.save().fillColor(BLACK).font('Helvetica').fontSize(8.5)
           .text(line, L+8, y+13+i*10, {width:W-16, lineBreak:false}).restore();
      });
      y += besH+6;
    }

    // MATERIAL-TABELLE
    const M1=L, M2=L+42, M3=R-130, M4=R-65;
    const MW=[42, M3-M2, 65, 65];
    const MH=12;

    box(doc, L, y, W, MH, NAVY, BLUE);
    ['Menge','Materialverbrauch / Bezeichnung','Einzel-Preis','Gesamt-Preis'].forEach((h,i)=>{
      const xs=[M1,M2,M3,M4];
      doc.save().fillColor(WHITE).font('Helvetica-Bold').fontSize(7)
         .text(h, xs[i]+2, y+3, {width:MW[i]-4, align:i===0?'left':'center', lineBreak:false}).restore();
    });
    y += MH;

    const matLines = linesFrom(report.material);
    const NUM_ROWS = Math.max(8, matLines.length+2);
    for (let i=0; i<NUM_ROWS; i++) {
      box(doc,L,y,W,MH,i%2===0?null:LGRAY,BLUE,0.3);
      [M2,M3,M4].forEach(x=>vl(doc,x,y,y+MH,BLUE,0.3));
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

    const kalk = berechneKalkulation(report);
    if (kalk) {
      [
        {label:'Nettosumme',            val:kalk.nettoText,  bg:LGRAY},
        {label:'MwSt. '+kalk.mwstSatz+'%', val:kalk.mwstText,  bg:LGRAY},
        {label:'Bruttosumme',           val:kalk.bruttoText, bg:NAVY, white:true},
      ].forEach(sr => {
        box(doc,L,y,W-130,MH,null,BLUE,0.3);
        box(doc,M3,y,65,MH,sr.bg||LGRAY,BLUE,0.4);
        box(doc,M4,y,65,MH,sr.bg||LGRAY,BLUE,0.4);
        doc.save().fillColor(NAVY).font('Helvetica').fontSize(7.5)
           .text(sr.label, M2+3, y+3, {width:130, lineBreak:false}).restore();
        doc.save().fillColor(sr.white?WHITE:BLACK).font('Helvetica-Bold').fontSize(8.5)
           .text(sr.val, M4+2, y+2, {width:61, align:'right', lineBreak:false}).restore();
        y += MH;
      });
    }
    y += 8;

    // FOTOS
    if (Array.isArray(report.fotos) && report.fotos.length) {
      hl(doc, L, y, R, NAVY, 0.8);
      y += 6;
      doc.save().fillColor(NAVY).font('Helvetica-Bold').fontSize(8).text('Fotodokumentation', L, y).restore();
      y += 14;
      for (const foto of report.fotos) {
        try {
          if (y > 700) { doc.addPage(); y = 30; }
          doc.image(foto, L, y, {fit:[W,210], align:'center'});
          y += 218;
        } catch(e) {}
      }
      y += 6;
    }

    // UNTERSCHRIFTEN-FOOTER
    if (y > 770) { doc.addPage(); y = 30; }
    hl(doc, L, y, R, NAVY, 1);
    y += 6;
    doc.save().fillColor(GRAY).font('Helvetica').fontSize(7)
       .text('Zeit und Materialverbrauch anerkannt. Reparatur richtig ausgeführt.', L, y).restore();
    y += 14;

    const SW = (W-8)/3;
    const sigPos = [L, L+SW+4, L+2*(SW+4)];
    const sigTitles = ['Auftragnehmer','Auftraggeber / Mieter','Bauführer'];

    sigPos.forEach((sx, i) => {
      box(doc, sx, y, SW, 36, i===1&&signatureDataUrl?null:LGRAY, BLUE, 0.5);
      if (i===1 && signatureDataUrl) {
        try {
          const b64 = signatureDataUrl.replace(/^data:image\/\w+;base64,/, '');
          doc.image(Buffer.from(b64,'base64'), sx+4, y+2, {fit:[SW-8,32], align:'center'});
        } catch(e) {}
      }
      hl(doc, sx, y+36, sx+SW, NAVY, 0.8);
      doc.save().fillColor(NAVY).font('Helvetica-Bold').fontSize(7)
         .text(sigTitles[i], sx, y+39, {width:SW, align:'center', lineBreak:false}).restore();
    });
    y += 52;

    if (signatureDataUrl) {
      doc.save().fillColor(GRAY).font('Helvetica').fontSize(6.5)
         .text('Elektronisch unterschrieben am '+todayStr(), L, y, {width:W, align:'center'}).restore();
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
