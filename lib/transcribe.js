// Transkribiert ein Audio-Buffer mit Groq (Whisper large v3).
// Unterstuetzt automatische Spracherkennung fuer Tuerkisch, Deutsch, Albanisch u.a.
async function transcribeAudio(buffer, mimeType) {
  const apiKey = process.env.GROQ_API_KEY;
  if (!apiKey) {
    throw new Error('GROQ_API_KEY ist nicht gesetzt');
  }

  let filename = 'audio.ogg';
  if (mimeType) {
    if (mimeType.includes('mpeg') || mimeType.includes('mp3')) filename = 'audio.mp3';
    else if (mimeType.includes('mp4') || mimeType.includes('m4a')) filename = 'audio.m4a';
    else if (mimeType.includes('wav')) filename = 'audio.wav';
    else if (mimeType.includes('ogg') || mimeType.includes('opus')) filename = 'audio.ogg';
  }

  const form = new FormData();
  form.append('file', new Blob([buffer], { type: mimeType || 'audio/ogg' }), filename);
  form.append('model', 'whisper-large-v3');
  form.append('response_format', 'json');

  const resp = await fetch('https://api.groq.com/openai/v1/audio/transcriptions', {
    method: 'POST',
    headers: { Authorization: `Bearer ${apiKey}` },
    body: form
  });

  if (!resp.ok) {
    throw new Error(`Groq Transkription Fehler ${resp.status}: ${await resp.text()}`);
  }
  const data = await resp.json();
  return (data.text || '').trim();
}

module.exports = { transcribeAudio };
