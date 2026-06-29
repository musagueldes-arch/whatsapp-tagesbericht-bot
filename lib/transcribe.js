// Whisper-Transkription für Audio und Video-Ton
// Sprachen: Deutsch, Polnisch, Russisch, Aserbaidschanisch – automatische Erkennung

const { execSync } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');

// Konvertiert beliebiges Audio (ogg/opus von WhatsApp) zu MP3 via ffmpeg
// MP3 wird zuverlässig von Whisper akzeptiert
function convertToMp3(inputBuffer, inputExt) {
  const tmpDir = os.tmpdir();
  const ts = Date.now();
  const inputPath = path.join(tmpDir, `gtherm_in_${ts}.${inputExt}`);
  const outputPath = path.join(tmpDir, `gtherm_out_${ts}.mp3`);
  try {
    fs.writeFileSync(inputPath, inputBuffer);
    execSync(`ffmpeg -y -i "${inputPath}" -ar 16000 -ac 1 -b:a 64k "${outputPath}"`, {
      timeout: 30000,
      stdio: 'pipe'
    });
    const mp3Buffer = fs.readFileSync(outputPath);
    return mp3Buffer;
  } finally {
    try { fs.unlinkSync(inputPath); } catch {}
    try { fs.unlinkSync(outputPath); } catch {}
  }
}

// Extrahiert Audio aus Video als MP3
function extractAudioFromVideo(videoBuffer, videoMime) {
  const tmpDir = os.tmpdir();
  const ts = Date.now();
  const ext = videoMime.includes('mp4') ? 'mp4' : videoMime.includes('3gpp') ? '3gp' : 'mp4';
  const inputPath = path.join(tmpDir, `gtherm_video_${ts}.${ext}`);
  const outputPath = path.join(tmpDir, `gtherm_audio_${ts}.mp3`);
  try {
    fs.writeFileSync(inputPath, videoBuffer);
    execSync(`ffmpeg -y -i "${inputPath}" -vn -ar 16000 -ac 1 -b:a 64k "${outputPath}"`, {
      timeout: 60000,
      stdio: 'pipe'
    });
    return fs.readFileSync(outputPath);
  } finally {
    try { fs.unlinkSync(inputPath); } catch {}
    try { fs.unlinkSync(outputPath); } catch {}
  }
}

// Extrahiert Frames aus Video als JPEG-Array
function extractFramesFromVideo(videoBuffer, videoMime, maxFrames = 8) {
  const tmpDir = os.tmpdir();
  const ts = Date.now();
  const ext = videoMime.includes('mp4') ? 'mp4' : videoMime.includes('3gpp') ? '3gp' : 'mp4';
  const inputPath = path.join(tmpDir, `gtherm_video_${ts}.${ext}`);
  const framePattern = path.join(tmpDir, `gtherm_frame_${ts}_%03d.jpg`);
  try {
    fs.writeFileSync(inputPath, videoBuffer);
    execSync(
      `ffmpeg -y -i "${inputPath}" -vf "fps=1/3,scale=1280:-1" -frames:v ${maxFrames} "${framePattern}"`,
      { timeout: 60000, stdio: 'pipe' }
    );
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

function detectLanguage(whisperData) {
  const code = (whisperData.language || 'de').toLowerCase();
  const map = {
    de: { label: 'Deutsch', flag: '🇩🇪' },
    pl: { label: 'Polnisch', flag: '🇵🇱' },
    ru: { label: 'Russisch', flag: '🇷🇺' },
    az: { label: 'Aserbaidschanisch', flag: '🇦🇿' }
  };
  return map[code] || { label: code.toUpperCase(), flag: '🌐' };
}

// Haupt-Transkriptionsfunktion
// audioBuffer: Buffer (rohe ogg/opus Daten von WhatsApp)
// Gibt { text, language } zurück
async function transcribeAudio(audioBuffer, mimeType) {
  const apiKey = process.env.OPENAI_API_KEY;
  if (!apiKey) throw new Error('OPENAI_API_KEY nicht gesetzt');

  // Erst zu MP3 konvertieren – zuverlässiger als OGG/Opus direkt
  let mp3Buffer;
  try {
    mp3Buffer = convertToMp3(audioBuffer, 'ogg');
  } catch (convErr) {
    console.error('ffmpeg Konvertierung fehlgeschlagen, sende roh:', convErr.message);
    // Fallback: roh senden
    mp3Buffer = audioBuffer;
  }

  const form = new FormData();
  form.append('file', new Blob([mp3Buffer], { type: 'audio/mpeg' }), 'voice.mp3');
  form.append('model', 'whisper-1');
  form.append('response_format', 'verbose_json');

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
