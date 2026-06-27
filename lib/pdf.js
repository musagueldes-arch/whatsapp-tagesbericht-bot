const PDFDocument = require('pdfkit');
const { todayStr } = require('./util');

const COLORS = {
  blueprint: '#1B2A4A',
  subtext: '#CFD5E3',
  orange: '#E8622C',
  label: '#8B92A0',
  text: '#222222'
};

function linesFrom(text) {
  return (text || '')
    .split('\n')
    .map((l) => l.trim())
    .filter(Boolean);
}

function generateReportPdfBuffer(report, company) {
  return new Promise((resolve, reject) => {
    const doc = new PDFDocument({ size: 'A4', margin: 50 });
    const buffers = [];
    doc.on('data', (chunk) => buffers.push(chunk));
    doc.on('end', () => resolve(Buffer.concat(buffers)));
    doc.on('error', reject);

    const pageWidth = doc.page.width;

    doc.rect(0, 0, pageWidth, 80).fill(COLORS.blueprint);
    doc
      .fillColor('#FFFFFF')
      .font('Helvetica-Bold')
      .fontSize(20)
      .text(`${company.firma || 'G-Therm Haustechnik'}`, 50, 22, { continued: true })
      .fillColor(COLORS.orange)
      .text(' Tagesbericht');
    const addrLine = [company.adresse, company.telefon, company.email].filter(Boolean).join(' · ');
    doc
      .fillColor(COLORS.subtext)
      .font('Helvetica')
      .fontSize(10)
      .text(addrLine || 'Heizung · Sanitaer · Elektro', 50, 50);

    const stampCx = pageWidth - 95;
    const stampCy = 40;
    doc.save();
    doc.dash(2, { space: 2 }).lineWidth(1.5).strokeColor(COLORS.orange);
    doc.circle(stampCx, stampCy, 32).stroke();
    doc.undash();
    doc
      .fillColor(COLORS.orange)
      .font('Helvetica-Bold')
      .fontSize(7)
      .text('G-THERM HAUSTECHNIK', stampCx - 30, stampCy - 17, { width: 60, align: 'center' });
    doc.fontSize(10).text(report.datum || '', stampCx - 30, stampCy + 6, { width: 60, align: 'center' });
    doc.restore();

    doc.y = 110;

    function fieldPair(label1, value1, label2, value2) {
      const startY = doc.y;
      doc.fillColor(COLORS.label).font('Helvetica-Bold').fontSize(9);
      doc.text(label1.toUpperCase(), 50, startY, { width: 240 });
      doc.fillColor(COLORS.text).font('Courier').fontSize(11);
      doc.text(value1 || '-', 50, startY + 13, { width: 240 });
      if (label2) {
        doc.fillColor(COLORS.label).font('Helvetica-Bold').fontSize(9);
        doc.text(label2.toUpperCase(), 310, startY, { width: 235 });
        doc.fillColor(COLORS.text).font('Courier').fontSize(11);
        doc.text(value2 || '-', 310, startY + 13, { width: 235 });
      }
      doc.y = startY + 38;
    }

    function fieldFull(label, value) {
      const startY = doc.y;
      doc.fillColor(COLORS.label).font('Helvetica-Bold').fontSize(9);
      doc.text(label.toUpperCase(), 50, startY, { width: 495 });
      doc.fillColor(COLORS.text).font('Helvetica').fontSize(12);
      doc.text(value || '-', 50, startY + 13, { width: 495 });
      doc.y = startY + Math.max(36, doc.heightOfString(value || '-', { width: 495 }) + 16);
    }

    fieldPair('Datum', report.datum, 'Arbeitszeit', report.arbeitszeit);
    fieldFull('Kunde / Baustelle', report.kunde);
    fieldPair('Referenz', report.referenz, 'Mitarbeiter', report.mitarbeiter);

    function listSection(title, text) {
      doc.fillColor(COLORS.label).font('Helvetica-Bold').fontSize(9);
      doc.text(title.toUpperCase(), 50, doc.y, { width: 495 });
      doc.moveDown(0.3);
      const lines = linesFrom(text);
      doc.fillColor(COLORS.text).font('Helvetica').fontSize(11);
      if (!lines.length) {
        doc.text('-', 58, doc.y, { width: 480 });
      } else {
        lines.forEach((line) => {
          doc.text(`• ${line}`, 58, doc.y, { width: 480 });
        });
      }
      doc.moveDown(0.6);
    }

    listSection('Durchgefuehrte Arbeiten', report.arbeiten);
    listSection('Material', report.material);
    listSection('Besonderheiten', report.besonderheiten);

    // --- Foto-Dokumentation (optional) ---
    if (Array.isArray(report.fotos) && report.fotos.length) {
      doc.moveDown(0.5);
      doc.fillColor(COLORS.label).font('Helvetica-Bold').fontSize(9);
      doc.text('FOTOS ZUR DOKUMENTATION', 50, doc.y, { width: 495 });
      doc.moveDown(0.5);
      for (const foto of report.fotos) {
        try {
          if (doc.y > doc.page.height - 220) doc.addPage();
          doc.image(foto, 50, doc.y, { fit: [495, 300], align: 'center' });
          doc.moveDown(0.5);
          doc.y += 6;
        } catch (e) {
          // defektes/nicht lesbares Bild ueberspringen
        }
      }
      doc.moveDown(0.6);
    }

    doc.moveDown(1);
    doc
      .moveTo(50, doc.y)
      .lineTo(pageWidth - 50, doc.y)
      .strokeColor('#DDDDDD')
      .lineWidth(1)
      .stroke();
    doc.moveDown(0.5);
    const footerY = doc.y;
    doc.fillColor(COLORS.label).font('Helvetica').fontSize(9);
    doc.text(company.inhaber || 'Musa Gueldes', 50, footerY, { width: 300 });
    doc.text(`Erstellt am ${todayStr()}`, pageWidth - 200, footerY, { width: 150, align: 'right' });

    doc.end();
  });
}

module.exports = { generateReportPdfBuffer };
