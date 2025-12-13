const express = require('express');
const cors = require('cors');
const { exec } = require('child_process');
const path = require('path');
const fs = require('fs').promises;
const multer = require('multer');
const { v4: uuidv4 } = require('uuid');

const app = express();
const PORT = process.env.PORT || 3000;

app.use(cors());
app.use(express.json({ limit: '50mb' }));
app.use(express.static('public'));

const TEMP_DIR = path.join(__dirname, 'temp');
const OUTPUT_DIR = path.join(__dirname, 'output');

async function ensureDirectories() {
  await fs.mkdir(TEMP_DIR, { recursive: true });
  await fs.mkdir(OUTPUT_DIR, { recursive: true });
}

const storage = multer.diskStorage({
  destination: TEMP_DIR,
  filename: (req, file, cb) => {
    const uniqueName = `${uuidv4()}-${file.originalname}`;
    cb(null, uniqueName);
  }
});

const upload = multer({ 
  storage,
  limits: { fileSize: 5 * 1024 * 1024 * 1024 }
});

const presets = {
  balanced: { resolution: '1080', fps: '30', crf: '23', preset: 'medium', maxSize: '1400M' },
  efficient: { resolution: '720', fps: '30', crf: '28', preset: 'fast', maxSize: '800M' },
  minimal: { resolution: '720', fps: '24', crf: '32', preset: 'veryfast', maxSize: '500M' }
};

function convertYouTubeUrl(url) {
  // Extract video ID from various YouTube URL formats
  let videoId = null;
  
  // Standard watch URL: youtube.com/watch?v=VIDEO_ID
  const watchMatch = url.match(/[?&]v=([^&]+)/);
  if (watchMatch) {
    videoId = watchMatch[1];
  }
  
  // Short URL: youtu.be/VIDEO_ID
  const shortMatch = url.match(/youtu\.be\/([^?&]+)/);
  if (shortMatch) {
    videoId = shortMatch[1];
  }
  
  // Embed URL: youtube.com/embed/VIDEO_ID
  const embedMatch = url.match(/youtube\.com\/embed\/([^?&]+)/);
  if (embedMatch) {
    videoId = embedMatch[1];
  }
  
  // If we found a video ID, convert to nocookie embed format
  if (videoId) {
    return `https://www.youtube-nocookie.com/embed/${videoId}?playlist=${videoId}&autoplay=1&iv_load_policy=3&loop=1&start=`;
  }
  
  // If no YouTube pattern matched, return original URL
  return url;
}

function execCommand(command) {
  return new Promise((resolve, reject) => {
    exec(command, { maxBuffer: 1024 * 1024 * 10 }, (error, stdout, stderr) => {
      if (error) {
        reject({ error, stderr });
      } else {
        resolve({ stdout, stderr });
      }
    });
  });
}

async function cleanupOldFiles() {
  try {
    const files = await fs.readdir(OUTPUT_DIR);
    const now = Date.now();
    for (const file of files) {
      const filePath = path.join(OUTPUT_DIR, file);
      const stats = await fs.stat(filePath);
      const age = now - stats.mtimeMs;
      if (age > 60 * 60 * 1000) {
        await fs.unlink(filePath);
      }
    }
  } catch (err) {
    console.error('Cleanup error:', err);
  }
}

app.get('/api/health', async (req, res) => {
  try {
    await execCommand('yt-dlp --version');
    await execCommand('ffmpeg -version');
    res.json({ status: 'ok', message: 'All dependencies installed' });
  } catch (err) {
    res.status(500).json({ status: 'error', message: 'Missing dependencies' });
  }
});

app.post('/api/download', async (req, res) => {
  const { url, preset = 'balanced' } = req.body;
  if (!url) {
    return res.status(400).json({ error: 'URL is required' });
  }
  const jobId = uuidv4();
  const processedUrl = convertYouTubeUrl(url);
  const config = presets[preset];
  const outputFile = path.join(OUTPUT_DIR, `${jobId}.mp4`);
  const tempFile = path.join(TEMP_DIR, `${jobId}_raw.mp4`);
  try {
    const downloadCmd = `yt-dlp --no-check-certificates --user-agent "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36" -f "bestvideo[height<=${config.resolution}][ext=mp4]+bestaudio[ext=m4a]/best" --merge-output-format mp4 -o "${tempFile}" "${processedUrl}"`;
    await execCommand(downloadCmd);
    const stats = await fs.stat(tempFile);
    const fileSizeMB = stats.size / (1024 * 1024);
    const maxSizeMB = parseInt(config.maxSize);
    if (fileSizeMB > maxSizeMB) {
      const compressCmd = `ffmpeg -i "${tempFile}" -vcodec libx264 -crf ${config.crf} -preset ${config.preset} -vf scale=-2:${config.resolution} -r ${config.fps} -fs ${config.maxSize} -movflags +faststart -y "${outputFile}"`;
      await execCommand(compressCmd);
      await fs.unlink(tempFile);
    } else {
      await fs.rename(tempFile, outputFile);
    }
    res.json({ success: true, jobId, downloadUrl: `/api/download/${jobId}`, message: 'Video processed successfully' });
  } catch (err) {
    console.error('Download error:', err);
    try {
      await fs.unlink(tempFile);
    } catch {}
    res.status(500).json({ error: 'Failed to download or process video', details: err.stderr || err.message });
  }
});

app.post('/api/compress', upload.single('video'), async (req, res) => {
  if (!req.file) {
    return res.status(400).json({ error: 'No file uploaded' });
  }
  const { preset = 'balanced' } = req.body;
  const jobId = uuidv4();
  const config = presets[preset];
  const inputFile = req.file.path;
  const outputFile = path.join(OUTPUT_DIR, `${jobId}.mp4`);
  try {
    const compressCmd = `ffmpeg -i "${inputFile}" -vcodec libx264 -crf ${config.crf} -preset ${config.preset} -vf scale=-2:${config.resolution} -r ${config.fps} -fs ${config.maxSize} -movflags +faststart -y "${outputFile}"`;
    await execCommand(compressCmd);
    const inputStats = await fs.stat(inputFile);
    const outputStats = await fs.stat(outputFile);
    const reduction = Math.round((1 - outputStats.size / inputStats.size) * 100);
    await fs.unlink(inputFile);
    res.json({ success: true, jobId, downloadUrl: `/api/download/${jobId}`, stats: { originalSize: Math.round(inputStats.size / (1024 * 1024)), compressedSize: Math.round(outputStats.size / (1024 * 1024)), reduction: reduction } });
  } catch (err) {
    console.error('Compression error:', err);
    try {
      await fs.unlink(inputFile);
    } catch {}
    res.status(500).json({ error: 'Failed to compress video', details: err.stderr || err.message });
  }
});

app.get('/api/download/:jobId', async (req, res) => {
  const { jobId } = req.params;
  const filePath = path.join(OUTPUT_DIR, `${jobId}.mp4`);
  try {
    await fs.access(filePath);
    res.download(filePath, 'gamerun_optimized.mp4', async (err) => {
      if (err) {
        console.error('Download error:', err);
      }
    });
  } catch (err) {
    res.status(404).json({ error: 'File not found' });
  }
});

ensureDirectories().then(() => {
  app.listen(PORT, () => {
    console.log(`Server running on port ${PORT}`);
    console.log(`Access at http://localhost:${PORT}`);
    setInterval(cleanupOldFiles, 30 * 60 * 1000);
  });
});