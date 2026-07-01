'use strict';
const puppeteer = require('puppeteer');
const { todayStr } = require('./util');

function esc(s) {
    return (s || '').replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;');
}

function lines(t) {
    return (t || '').split('\n').map(s => s.trim()).filter(Boolean);
}

function splitKunde(k) {
    if (!k) return { name: '', strasse: '', plzOrt: '' };
    const p = k.split(',').map(s => s.trim());
    if (p.length === 1) return { name: p[0], strasse: '', plzOrt: '' };
    if (p.length === 2) return { name: p[0], strasse: p[1], plzOrt: '' };
    return { name: p[0], strasse: p.slice(1, p.length-1).join(', '), plzOrt: p[p.length-1] };
}

function buildHtml(report, company, signatureDataUrl) {
    const matLines = lines(report.material);
    const arbLines = lines(report.arbeiten);
    const besText  = (report.besonderheiten || '').trim();
    const mitList  = lines((report.mitarbeiter || '').replace(/,/g, '\n'));
    const fotos    = (report.fotos || []).map(buf =>
          'data:image/jpeg;base64,' + (Buffer.isBuffer(buf) ? buf.toString('base64') : buf)
                                                );
    const kunde = splitKunde(report.kunde);
    const rollen = ['Monteur','Monteur','Helfer','Helfer'];
    const stundenRows = rollen.map((r, i) => {
          const name   = mitList[i] || '';
          const first  = i === 0;
          const datum  = first ? (report.datum || todayStr()) : '';
          const zeit   = first ? (report.arbeitszeit || '') : '';
          const von    = first && zeit.includes('-') ? zeit.split('-')[0].trim() : (first ? zeit : '');
          const bis    = first && zeit.includes('-') ? zeit.split('-')[1].trim() : '';
          return `<tr><td class="tn">${esc(r)}: ${esc(name)}</td><td class="tc">${esc(datum)}</td><td class="tc">${esc(von)}</td><td class="tc">${esc(bis)}</td><td class="tc"></td></tr>`;
    }).join('');
    const mc = Math.max(7, matLines.length + 2);
    let matRows = '';
    for (let i = 0; i < mc; i++) {
          const ln = matLines[i] || '';
          const m  = ln.match(/^(\d[\d.,]*\s*\w{0,5})\s+(.+)/);
          matRows += `<tr><td class="tmg">${esc(m?m[1]:'')}</td><td class="tbz">${esc(m?m[2]:ln)}</td><td class="tpr"></td><td class="tpr"></td></tr>`;
    }
    const fotoHtml = fotos.length > 0
      ? `<div class="slbl">Fotos</div><div class="fgrid">${fotos.map(s=>`<div class="fc"><img src="${s}"/></div>`).join('')}</div>`
          : '';
    const sigK = signatureDataUrl
      ? `<div class="sb"><div class="sl">Auftraggeber / Mieter</div><img class="si" src="${signatureDataUrl}"/></div>`
          : `<div class="sb"><div class="sl">Auftraggeber / Mieter</div><div class="sline"></div></div>`;
    const firma   = esc(company.firma   || 'G-Therm Haustechnik');
    const adresse = esc(company.adresse || 'Lindener Str. 111 \u00b7 44879 Bochum');
    const telefon = esc(company.telefon || '0234 - 544 618 55');

  return `<!DOCTYPE html><html lang="de"><head><meta charset="UTF-8"><style>
  *{margin:0;padding:0;box-sizing:border-box}
  body{font-family:Arial,Helvetica,sans-serif;font-size:8pt;color:#111;background:#fff}
  .page{width:210mm;padding:6mm 8mm 6mm 8mm}
  .hdr{background:#1B2A4A;color:#fff;display:flex;justify-content:space-between;align-items:center;padding:7px 10px}
  .hdr-icons{display:flex;gap:12px;margin-bottom:3px}
  .hi{text-align:center;font-size:5.5pt;color:#8fa0be}
  .hi b{display:block;font-size:12pt;margin-bottom:1px}
  .hr2{text-align:right;line-height:1.55;font-size:7.5pt;color:#c8d0df}
  .hf{font-size:13pt;font-weight:900;color:#fff;display:block;letter-spacing:.5px}
  .rbar{background:#C0392B;height:4px;margin-bottom:5px}
  .tr{display:flex;justify-content:space-between;align-items:baseline;margin-bottom:4px}
  .ti{font-size:14pt;font-weight:900;color:#1B2A4A}
  .td{font-size:7.5pt;color:#555}
  table{width:100%;border-collapse:collapse;margin-bottom:4px}
  td,th{border:.4pt solid #2C4A8A;padding:1.5px 3px;vertical-align:top;font-size:7.5pt}
  th{background:#1B2A4A;color:#fff;font-size:7pt;font-weight:700;padding:2px 3px;text-align:left}
  th.tc,td.tc{text-align:center}
  .lb{font-size:5.8pt;color:#1B2A4A;font-weight:700;display:block;margin-bottom:1px}
  .vl{font-size:8pt}
  .agt td{height:16px}
  .agt td.tall{height:44px;vertical-align:top}
  .cbx{font-size:6.5pt;line-height:1.8;padding:3px 4px}
  .cr{display:flex;align-items:center;gap:3px}
  .cb{width:7px;height:7px;border:.4pt solid #555;display:inline-block;flex-shrink:0}
  .dhr{border:0;border-top:.4pt solid #aaa;margin:2px 0}
  .sth td{height:13px}
  .tn{width:40%}
  .tc{text-align:center;width:15%}
  .ab{border:.4pt solid #2C4A8A;padding:3px 5px;margin-bottom:4px;min-height:60px}
  .alb{font-size:6.5pt;font-weight:700;color:#1B2A4A;margin-bottom:2px}
  .al{font-size:8pt;padding:.5px 0}
  .al::before{content:"• "}
  .bt{font-size:7pt;color:#444;font-style:italic;margin-top:3px;padding-top:2px;border-top:.4pt solid #ddd}
  .tmg{width:10%;text-align:center}
  .tbz{width:62%}
  .tpr{width:14%;text-align:right}
  .sr{display:flex;justify-content:flex-end;margin-bottom:1.5px}
  .slb{font-size:7.5pt;width:115px;text-align:right;padding-right:5px}
  .sv{font-size:7.5pt;width:80px;border-bottom:.4pt solid #999;text-align:right;min-height:13px;padding-right:3px}
  .slbl{font-size:7pt;font-weight:700;color:#1B2A4A;margin:5px 0 2px 0}
  .fgrid{display:flex;flex-wrap:wrap;gap:3px;margin-bottom:5px}
  .fc{width:85px;height:65px;overflow:hidden;border:.4pt solid #bbb}
  .fc img{width:100%;height:100%;object-fit:cover}
  .sft{display:flex;gap:5px;margin-top:8px}
  .sb{flex:1;border:.4pt solid #2C4A8A;padding:3px;min-height:50px}
  .sl{font-size:6pt;font-weight:700;color:#1B2A4A;margin-bottom:2px}
  .sline{border-top:.4pt solid #aaa;margin-top:30px}
  .si{max-width:100%;max-height:40px;display:block;margin-top:3px}
  </style></head><body><div class="page">
  <div class="hdr"><div><div class="hdr-icons"><div class="hi"><b>🔥</b>HEIZUNG</div><div class="hi"><b>💧</b>SANITÄR</div><div class="hi"><b>💨</b>LÜFTUNG</div></div></div><div class="hr2"><span class="hf">${firma}</span>${adresse}<br>${telefon}</div></div>
  <div class="rbar"></div>
  <div class="tr"><span class="ti">Auftrags- &amp; Stundenzettel</span><span class="td">Datum: ${esc(report.datum || todayStr())}</span></div>
  <table class="agt"><thead><tr>
    <th style="width:35%">Auftraggeber / Rechnungsempfänger</th>
      <th style="width:8%">Kunden-Nr.</th>
        <th style="width:35%">Kunde / Einsatzort</th>
          <th style="width:22%" rowspan="5" class="cbx"><div class="cr"><div class="cb"></div> Reparatur</div><div class="cr"><div class="cb"></div> Wartung</div><div class="cr"><div class="cb"></div> Leistung</div><div class="cr"><div class="cb"></div> Installation</div><div class="cr"><div class="cb"></div> Reinigung</div><div class="cr"><div class="cb"></div> Rohrbau</div><div class="cr"><div class="cb"></div> Neuanlage</div><div class="cr"><div class="cb"></div> Fertigmontage</div><div class="dhr"></div><div class="cr"><div class="cb"></div> Arbeit abgeschlossen</div><div class="cr"><div class="cb"></div> Weiterer Besuch erforderlich</div><div class="dhr"></div><div style="font-size:6pt">An-/Abfahrt: _______ km</div><div style="font-size:6pt">Notdienst: _______ Uhr</div></th>
          </tr></thead><tbody>
          <tr><td class="tall"><span class="lb">Vorname / Name</span><span class="vl">${esc(kunde.name)}</span></td><td><span class="lb">Referenz</span><span class="vl">${esc(report.referenz||'')}</span></td><td class="tall"><span class="lb">Vorname / Name</span><span class="vl">${esc(kunde.name)}</span></td></tr>
          <tr><td><span class="lb">Straße / Nr.</span><span class="vl">${esc(kunde.strasse)}</span></td><td><span class="lb">Mitarbeiter</span><span class="vl">${esc(report.mitarbeiter||'')}</span></td><td><span class="lb">Straße / Nr.</span><span class="vl">${esc(kunde.strasse)}</span></td></tr>
          <tr><td><span class="lb">PLZ / Ort</span><span class="vl">${esc(kunde.plzOrt)}</span></td><td><span class="lb">Arbeitszeit</span><span class="vl">${esc(report.arbeitszeit||'')}</span></td><td><span class="lb">PLZ / Ort</span><span class="vl">${esc(kunde.plzOrt)}</span></td></tr>
          <tr><td><span class="lb">Tel. erreichbar</span></td><td></td><td><span class="lb">Tel. erreichbar</span></td></tr>
          </tbody></table>
          <table class="sth"><thead><tr><th style="width:40%">Monteur / Helfer</th><th class="tc" style="width:18%">Datum</th><th class="tc" style="width:14%">Von</th><th class="tc" style="width:14%">Bis</th><th class="tc" style="width:14%">Gesamt Std.</th></tr></thead><tbody>${stundenRows}</tbody></table>
          <div class="ab"><div class="alb">Auszuführende Arbeit:</div>${arbLines.map(l=>`<div class="al">${esc(l)}</div>`).join('')}${besText?`<div class="bt">${esc(besText)}</div>`:''}</div>
          <table><thead><tr><th class="tc">Menge</th><th>Materialverbrauch / Bezeichnung</th><th class="tc">Einzel-Preis</th><th class="tc">Gesamt-Preis</th></tr></thead><tbody>${matRows}</tbody></table>
          <div style="margin-bottom:6px"><div class="sr"><span class="slb">Nettosumme</span><span class="sv"></span></div><div class="sr"><span class="slb">+ MwSt. _______ %</span><span class="sv"></span></div><div class="sr"><span class="slb" style="font-weight:700">Bruttosumme</span><span class="sv" style="font-weight:700;border-bottom:.8pt solid #111"></span></div></div>
          <div style="font-size:7pt;color:#333;margin-bottom:5px">Zeit und Materialverbrauch anerkannt. Reparatur richtig ausgeführt.</div>
          ${fotoHtml}
          <div class="sft"><div class="sb"><div class="sl">Auftragnehmer</div><div class="sline"></div></div>${sigK}<div class="sb"><div class="sl">Bauführer</div><div class="sline"></div></div></div>
          </div></body></html>`;
}

async function generateReportPdfBuffer(report, company, signatureDataUrl) {
    const html = buildHtml(report, company, signatureDataUrl);
    const browser = await puppeteer.launch({
          headless: true,
          args: ['--no-sandbox','--disable-setuid-sandbox','--disable-dev-shm-usage',
                            '--disable-gpu','--no-first-run','--no-zygote','--single-process']
    });
    try {
          const page = await browser.newPage();
          await page.setContent(html, { waitUntil: 'networkidle0' });
          return await page.pdf({ format: 'A4', printBackground: true,
                                       margin: { top: '0', right: '0', bottom: '0', left: '0' } });
    } finally {
          await browser.close();
    }
}

module.exports = { generateReportPdfBuffer };
