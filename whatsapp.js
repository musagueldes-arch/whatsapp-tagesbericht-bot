function graphBase() {
  const version = process.env.WHATSAPP_API_VERSION || 'v21.0';
  return `https://graph.facebook.com/${version}`;
}

function requireEnv() {
  const phoneId = process.env.WHATSAPP_PHONE_NUMBER_ID;
  const token = process.env.WHATSAPP_TOKEN;
  if (!phoneId || !token) {
    throw new Error('WHATSAPP_PHONE_NUMBER_ID oder WHATSAPP_TOKEN fehlt (.env pruefen)');
  }
  return { phoneId, token };
}

async function sendText(to, body) {
  const { phoneId, token } = requireEnv();
  const resp = await fetch(`${graphBase()}/${phoneId}/messages`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
    body: JSON.stringify({ messaging_product: 'whatsapp', to, type: 'text', text: { body } })
  });
  if (!resp.ok) throw new Error(`WhatsApp sendText Fehler ${resp.status}: ${await resp.text()}`);
  return resp.json();
}

async function uploadMedia(buffer, filename, mimeType) {
  const { phoneId, token } = requireEnv();
  const form = new FormData();
  form.append('messaging_product', 'whatsapp');
  form.append('file', new Blob([buffer], { type: mimeType }), filename);
  const resp = await fetch(`${graphBase()}/${phoneId}/media`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${token}` },
    body: form
  });
  if (!resp.ok) throw new Error(`WhatsApp uploadMedia Fehler ${resp.status}: ${await resp.text()}`);
  const data = await resp.json();
  return data.id;
}

async function sendDocument(to, mediaId, filename, caption) {
  const { phoneId, token } = requireEnv();
  const resp = await fetch(`${graphBase()}/${phoneId}/messages`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
    body: JSON.stringify({
      messaging_product: 'whatsapp', to, type: 'document',
      document: { id: mediaId, filename, caption }
    })
  });
  if (!resp.ok) throw new Error(`WhatsApp sendDocument Fehler ${resp.status}: ${await resp.text()}`);
  return resp.json();
}

// Foto von WhatsApp herunterladen → base64-String + mimeType
async function downloadMedia(mediaId) {
  const { token } = requireEnv();
  // 1. Media-URL holen
  const metaResp = await fetch(`${graphBase()}/${mediaId}`, {
    headers: { Authorization: `Bearer ${token}` }
  });
  if (!metaResp.ok) throw new Error(`WhatsApp downloadMedia Meta Fehler ${metaResp.status}`);
  const meta = await metaResp.json();
  const mimeType = meta.mime_type || 'image/jpeg';

  // 2. Bild herunterladen
  const imgResp = await fetch(meta.url, {
    headers: { Authorization: `Bearer ${token}` }
  });
  if (!imgResp.ok) throw new Error(`WhatsApp downloadMedia Bild Fehler ${imgResp.status}`);
  const arrayBuf = await imgResp.arrayBuffer();
  const base64 = Buffer.from(arrayBuf).toString('base64');
  return { base64, mimeType };
}

module.exports = { sendText, uploadMedia, sendDocument, downloadMedia };
