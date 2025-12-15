process.on('uncaughtException', (error) => {
    console.error('Uncaught Exception:', error);
});

process.on('unhandledRejection', (reason, promise) => {
    console.error('Unhandled Rejection at:', promise, 'reason:', reason);
});

// Graceful shutdown
process.on('SIGTERM', () => {
    console.log('SIGTERM signal received: closing HTTP server');
    server.close(() => {
        console.log('HTTP server closed');
    });
});

const express = require('express');
const cors = require('cors');
const { exec } = require('child_process');
const path = require('path');
const fs = require('fs').promises;
const multer = require('multer');
const { v4: uuidv4 } = require('uuid');

const app = express();
const PORT = process.env.PORT || 8080;

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
  limits: { 
    fileSize: 5 * 1024 * 1024 * 1024, // 5GB
    files: 1
  }
});

const presets = {
  balanced: { resolution: '1080', fps: '30', crf: '23', preset: 'medium', maxSize: '1400M' },
  efficient: { resolution: '720', fps: '30', crf: '28', preset: 'fast', maxSize: '800M' },
  minimal: { resolution: '720', fps: '24', crf: '32', preset: 'veryfast', maxSize: '500M' }
};

// Job storage for async compression
const jobs = new Map();

function convertYouTubeUrl(url) {
  return url;
}

function execCommand(command, timeout = 600000) { // 10 minute timeout
  return new Promise((resolve, reject) => {
    const child = exec(command, { 
      maxBuffer: 1024 * 1024 * 10,
      timeout: timeout
    }, (error, stdout, stderr) => {
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
      if (age > 60 * 60 * 1000) { // 1 hour
        await fs.unlink(filePath);
        console.log(`Cleaned up old file: ${file}`);
      }
    }
  } catch (err) {
    console.error('Cleanup error:', err);
  }
}

// Health check endpoint
app.get('/health', (req, res) => {
    res.status(200).json({ status: 'ok', timestamp: new Date().toISOString() });
});

app.get('/api/health', async (req, res) => {
  try {
    await execCommand('yt-dlp --version', 5000);
    await execCommand('ffmpeg -version', 5000);
    res.json({ status: 'ok', message: 'All dependencies installed' });
  } catch (err) {
    res.status(500).json({ status: 'error', message: 'Missing dependencies', error: err.message });
  }
});

// Root route
app.get('/', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
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
    console.log(`Starting download for job ${jobId}`);
    
    const downloadCmd = `yt-dlp --extractor-args "youtube:player_client=android" --user-agent "com.google.android.youtube/17.36.4 (Linux; U; Android 12; GB) gzip" -f "bestvideo[height<=${config.resolution}][ext=mp4]+bestaudio[ext=m4a]/best" --merge-output-format mp4 -o "${tempFile}" "${processedUrl}"`;
    await execCommand(downloadCmd);
    
    const stats = await fs.stat(tempFile);
    const fileSizeMB = stats.size / (1024 * 1024);
    const maxSizeMB = parseInt(config.maxSize);
    
    if (fileSizeMB > maxSizeMB) {
      console.log(`Compressing ${jobId}: ${fileSizeMB}MB > ${maxSizeMB}MB`);
      const compressCmd = `ffmpeg -i "${tempFile}" -vcodec libx264 -crf ${config.crf} -preset ${config.preset} -vf scale=-2:${config.resolution} -r ${config.fps} -fs ${config.maxSize} -movflags +faststart -y "${outputFile}"`;
      await execCommand(compressCmd);
      await fs.unlink(tempFile);
    } else {
      await fs.rename(tempFile, outputFile);
    }
    
    console.log(`Download complete for job ${jobId}`);
    res.json({ 
      success: true, 
      jobId, 
      downloadUrl: `/api/download/${jobId}`, 
      message: 'Video processed successfully' 
    });
  } catch (err) {
    console.error('Download error:', err);
    try {
      await fs.unlink(tempFile);
    } catch {}
    res.status(500).json({ 
      error: 'Failed to download or process video', 
      details: err.stderr || err.message 
    });
  }
});

// Compress uploaded file endpoint - Returns job ID immediately
app.post('/api/compress', upload.single('video'), async (req, res) => {
  if (!req.file) {
    return res.status(400).json({ error: 'No file uploaded' });
  }

  const { preset = 'balanced' } = req.body;
  const jobId = uuidv4();
  
  console.log(`New compression job ${jobId}: ${req.file.originalname} (${(req.file.size / (1024*1024)).toFixed(2)}MB)`);
  
  // Store job info
  jobs.set(jobId, {
    status: 'processing',
    progress: 0,
    inputFile: req.file.path,
    preset: preset
  });

  // Return job ID immediately
  res.json({ 
    success: true, 
    jobId,
    statusUrl: `/api/status/${jobId}`,
    message: 'Processing started'
  });

  // Process in background (don't await)
  processCompressionJob(jobId, req.file.path, preset).catch(err => {
    console.error(`Background job ${jobId} error:`, err);
  });
});

// Background compression processor
async function processCompressionJob(jobId, inputFile, presetName) {
  const config = presets[presetName];
  const outputFile = path.join(OUTPUT_DIR, `${jobId}.mp4`);

  try {
    console.log(`Processing job ${jobId} with preset ${presetName}`);
    
    // Update status to compressing
    jobs.set(jobId, { ...jobs.get(jobId), status: 'compressing', progress: 25 });

    // Build ffmpeg command
    const compressCmd = `ffmpeg -i "${inputFile}" -vcodec libx264 -crf ${config.crf} -preset ${config.preset} -vf scale=-2:${config.resolution} -r ${config.fps} -fs ${config.maxSize} -movflags +faststart -y "${outputFile}"`;
    
    // Run compression
    await execCommand(compressCmd);

    // Get file sizes for stats
    const inputStats = await fs.stat(inputFile);
    const outputStats = await fs.stat(outputFile);
    const reduction = Math.round((1 - outputStats.size / inputStats.size) * 100);

    console.log(`Job ${jobId} complete: ${(inputStats.size / (1024*1024)).toFixed(2)}MB → ${(outputStats.size / (1024*1024)).toFixed(2)}MB (${reduction}% reduction)`);

    // Cleanup input file
    await fs.unlink(inputFile);

    // Mark job as complete
    jobs.set(jobId, {
      status: 'complete',
      progress: 100,
      downloadUrl: `/api/download/${jobId}`,
      stats: {
        originalSize: Math.round(inputStats.size / (1024 * 1024)),
        compressedSize: Math.round(outputStats.size / (1024 * 1024)),
        reduction: reduction
      }
    });

  } catch (err) {
    console.error(`Compression error for job ${jobId}:`, err);
    
    // Cleanup input file on error
    try {
      await fs.unlink(inputFile);
    } catch {}
    
    // Mark job as failed
    jobs.set(jobId, {
      status: 'error',
      progress: 0,
      error: 'Failed to compress video',
      details: err.stderr || err.message
    });
  }
}

// Job status endpoint
app.get('/api/status/:jobId', (req, res) => {
  const { jobId } = req.params;
  const job = jobs.get(jobId);
  
  if (!job) {
    return res.status(404).json({ error: 'Job not found' });
  }
  
  res.json(job);
});

// Download endpoint
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

// Start server
let server;

ensureDirectories().then(() => {
  server = app.listen(PORT, '0.0.0.0', () => {
    console.log(`✓ Server running on port ${PORT}`);
    console.log(`✓ Environment: ${process.env.NODE_ENV || 'development'}`);
    console.log(`✓ Ready to accept requests`);
    
    // Start cleanup interval
    setInterval(cleanupOldFiles, 30 * 60 * 1000); // Every 30 minutes
  });
}).catch(err => {
  console.error('Failed to start server:', err);
  process.exit(1);
});
