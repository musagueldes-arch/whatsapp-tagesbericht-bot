
// Whisper-Transkription für Audio und Video-Ton
// Sprachen: Deutsch, Polnisch, Russisch, Aserbaidschanisch – automatische Erkennung

const { execSync } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');

// Extrahiert Audio aus Video als ogg-Datei (für Whisper)
function extractAudioFromVideo(videoBuffer, videoMime) {
  const tmpDir = os.tmpdir();
  const ext = videoMime.includes('mp4') ? 'mp4' : videoMime.includes('3gpp') ? '3gp' : 'mp4';
  const inputPath = path.join(tmpDir, `gtherm_video_${Date.now()}.${ext}`);
  const outputPath = path.join(tmpDir, `gtherm_audio_${Date.now()}.ogg`);

  try {
    fs.writeFileSync(inputPath, videoBuffer);
    execSync(`ffmpeg -y -i "${inputPath}" -vn -acodec libvorbis -q:a 4 "${outputPath}"`, {
      timeout: 60000,
      stdio: 'pipe'
    });
    const audioBuffer = fs.readFileSync(outputPath);
    return audioBuffer;
  } finally {
    try { fs.unlinkSync(inputPath); } catch {}
    try { fs.unlinkSync(outputPath); } catch {}
  }
}

// Extrahiert Frames aus Video als JPEG-Buffer-Array
function extractFramesFromVideo(videoBuffer, videoMime, maxFrames = 8) {
  const tmpDir = os.tmpdir();
  const ext = videoMime.includes('mp4') ? 'mp4' : videoMime.includes('3gpp') ? '3gp' : 'mp4';
  const inputPath = path.join(tmpDir, `gtherm_video_${Date.now()}.${ext}`);
  const framePattern = path.join(tmpDir, `gtherm_frame_${Date.now()}_%03d.jpg`);

  try {
    fs.writeFileSync(inputPath, videoBuffer);
    // Alle 3 Sekunden einen Frame, max maxFrames Stück
    execSync(
      `ffmpeg -y -i "${inputPath}" -vf "fps=1/3,scale=1280:-1" -frames:v ${maxFrames} "${framePattern}"`,
      { timeout: 60000, stdio: 'pipe' }
    );

    // Alle erzeugten Frame-Dateien einlesen
    const frames = [];
    for (let i = 1; i <= maxFrames; i++) {
      const framePath = framePattern.replace('%03d', String(i).padStart(3, '0'));
      if (fs.existsSync(framePath)) {
        const buf = fs.readFileSync(framePath);
        frames.push({ base64: buf.toString('base64'), mimeType: 'image/jpeg' });
        try { fs.unlinkSync(framePath); } catch {}
      }
    }
    return frames;
  } finally {
    try { fs.unlinkSync(inputPath); } catch {}
  }
}

// Erkennt Sprache aus Whisper-Antwort (erweiterte API mit verbose_json)
function detectLanguage(whisperData) {
  const code = whisperData.language || 'de';
  const map = {
    de: { label: 'Deutsch', flag: '🇩🇪' },
    pl: { label: 'Polnisch', flag: '🇵🇱' },
    ru: { label: 'Russisch', flag: '🇷🇺' },
    az: { label: 'Aserbaidschanisch', flag: '🇦🇿' }
  };
  return map[code] || { label: code.toUpperCase(), flag: '🌐' };
}

// Haupt-Transkriptionsfunktion
// audioBuffer: Buffer, mimeType: string
// Gibt { text, language } zurück
async function transcribeAudio(audioBuffer, mimeType) {
  const apiKey = process.env.OPENAI_API_KEY;
  if (!apiKey) throw new Error('OPENAI_API_KEY nicht gesetzt');

  const form = new FormData();
  form.append('file', new Blob([audioBuffer], { type: 'audio/ogg' }), 'voice.ogg');
  form.append('model', 'whisper-1');
  form.append('response_format', 'verbose_json');
  // Kein language-Parameter → automatische Erkennung

  const resp = await fetch('https://api.openai.com/v1/audio/transcriptions', {
    method: 'POST',
    headers: { Authorization: `Bearer ${apiKey}` },
    body: form
  });

  if (!resp.ok) {
    const errText = await resp.text();
    throw new Error(`Whisper ${resp.status}: ${errText}`);
  }

  const data = await resp.json();
  const text = (data.text || '').trim();
  if (!text || text.length < 2) throw new Error('Leere Transkription');

  const language = detectLanguage(data);
  return { text, language };
}

module.exports = { transcribeAudio, extractAudioFromVideo, extractFramesFromVideo };
