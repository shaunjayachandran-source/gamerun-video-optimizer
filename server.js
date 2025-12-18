process.on('uncaughtException', (error) => {
    console.error('Uncaught Exception:', error);
});

process.on('unhandledRejection', (reason, promise) => {
    console.error('Unhandled Rejection at:', promise, 'reason:', reason);
});

const express = require('express');
const cors = require('cors');
const { spawn } = require('child_process');
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

const activeProcesses = new Map();
const fileDeletionTimers = new Map();

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
    fileSize: 5 * 1024 * 1024 * 1024,
    files: 1
  }
});

const presets = {
  balanced: { resolution: '1080', fps: '30', crf: '23', preset: 'medium', maxSize: '1400M' },
  efficient: { resolution: '720', fps: '30', crf: '28', preset: 'fast', maxSize: '800M' },
  minimal: { resolution: '720', fps: '24', crf: '32', preset: 'veryfast', maxSize: '500M' }
};

const jobs = new Map();

function execCommand(command, timeout = 600000) {
  return new Promise((resolve, reject) => {
    exec(command, { 
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

function spawnFFmpeg(inputFile, outputFile, config, jobId) {
  return new Promise((resolve, reject) => {
    const args = [
      '-i', inputFile,
      '-vcodec', 'libx264',
      '-crf', config.crf,
      '-preset', config.preset,
      '-vf', `scale=-2:${config.resolution}`,
      '-r', config.fps,
      '-fs', config.maxSize,
      '-movflags', '+faststart',
      '-progress', 'pipe:2',
      '-y',
      outputFile
    ];

    const ffmpeg = spawn('ffmpeg', args);
    activeProcesses.set(jobId, ffmpeg);

    let stderr = '';
    let duration = 0;
    let lastProgress = 0;

    ffmpeg.stderr.on('data', (data) => {
      const text = data.toString();
      stderr += text;

      if (duration === 0) {
        const durationMatch = text.match(/Duration: (\d+):(\d+):(\d+\.\d+)/);
        if (durationMatch) {
          const hours = parseInt(durationMatch[1]);
          const minutes = parseInt(durationMatch[2]);
          const seconds = parseFloat(durationMatch[3]);
          duration = hours * 3600 + minutes * 60 + seconds;
        }
      }

      const timeMatch = text.match(/time=(\d+):(\d+):(\d+\.\d+)/);
      if (timeMatch && duration > 0) {
        const hours = parseInt(timeMatch[1]);
        const minutes = parseInt(timeMatch[2]);
        const seconds = parseFloat(timeMatch[3]);
        const currentTime = hours * 3600 + minutes * 60 + seconds;
        const progress = Math.min(Math.round((currentTime / duration) * 100), 99);
        
        if (progress > lastProgress) {
          lastProgress = progress;
          const job = jobs.get(jobId);
          if (job) {
            jobs.set(jobId, { ...job, progress: progress });
          }
        }
      }
    });

    ffmpeg.on('close', (code) => {
      activeProcesses.delete(jobId);
      if (code === 0) {
        resolve({ success: true });
      } else {
        reject({ error: new Error(`FFmpeg exited with code ${code}`), stderr });
      }
    });

    ffmpeg.on('error', (err) => {
      activeProcesses.delete(jobId);
      reject({ error: err, stderr });
    });
  });
}

function scheduleFileDeletion(filePath, delayMinutes, jobId = null) {
  const delayMs = delayMinutes * 60 * 1000;
  const timerId = setTimeout(async () => {
    try {
      await fs.unlink(filePath);
      console.log(`🗑️ Auto-deleted: ${path.basename(filePath)}`);
      fileDeletionTimers.delete(filePath);
      if (jobId) jobs.delete(jobId);
    } catch (err) {
      if (err.code !== 'ENOENT') console.error(`Delete failed:`, err.message);
    }
  }, delayMs);
  fileDeletionTimers.set(filePath, timerId);
  console.log(`⏰ Scheduled: ${path.basename(filePath)} in ${delayMinutes}min`);
}

function cancelFileDeletion(filePath) {
  const timerId = fileDeletionTimers.get(filePath);
  if (timerId) {
    clearTimeout(timerId);
    fileDeletionTimers.delete(filePath);
  }
}

app.get('/health', (req, res) => {
    res.status(200).json({ 
      status: 'ok', 
      timestamp: new Date().toISOString(),
      activeJobs: jobs.size,
      activeProcesses: activeProcesses.size
    });
});

app.get('/api/health', async (req, res) => {
  try {
    await execCommand('yt-dlp --version', 5000);
    await execCommand('ffmpeg -version', 5000);
    res.json({ status: 'ok', message: 'All dependencies installed' });
  } catch (err) {
    res.status(500).json({ status: 'error', message: 'Missing dependencies' });
  }
});

app.get('/', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

app.post('/api/compress', upload.single('video'), async (req, res) => {
  if (!req.file) {
    return res.status(400).json({ error: 'No file uploaded' });
  }

  const { preset = 'balanced' } = req.body;
  const jobId = uuidv4();
  
  console.log(`New job ${jobId}: ${req.file.originalname} (${(req.file.size / (1024*1024)).toFixed(2)}MB)`);
  
  jobs.set(jobId, {
    status: 'processing',
    progress: 0,
    inputFile: req.file.path,
    preset: preset
  });

  res.json({ 
    success: true, 
    jobId,
    statusUrl: `/api/status/${jobId}`,
    message: 'Processing started'
  });

  processCompressionJob(jobId, req.file.path, preset).catch(err => {
    console.error(`Job ${jobId} error:`, err);
  });
});

async function processCompressionJob(jobId, inputFile, presetName) {
  const config = presets[presetName];
  const outputFile = path.join(OUTPUT_DIR, `${jobId}.mp4`);

  try {
    console.log(`Processing ${jobId} with ${presetName}`);
    jobs.set(jobId, { ...jobs.get(jobId), status: 'compressing', progress: 5 });

    await spawnFFmpeg(inputFile, outputFile, config, jobId);

    const inputStats = await fs.stat(inputFile);
    const outputStats = await fs.stat(outputFile);
    const reduction = Math.round((1 - outputStats.size / inputStats.size) * 100);

    console.log(`Job ${jobId} complete: ${(inputStats.size / (1024*1024)).toFixed(2)}MB → ${(outputStats.size / (1024*1024)).toFixed(2)}MB (${reduction}%)`);

    await fs.unlink(inputFile);
    scheduleFileDeletion(outputFile, 20, jobId);

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
    console.error(`Compression error ${jobId}:`, err);
    try { await fs.unlink(inputFile); } catch {}
    jobs.set(jobId, {
      status: 'error',
      progress: 0,
      error: 'Failed to compress video'
    });
  }
}

app.get('/api/status/:jobId', (req, res) => {
  const job = jobs.get(req.params.jobId);
  if (!job) return res.status(404).json({ error: 'Job not found' });
  res.json(job);
});

app.get('/api/download/:jobId', async (req, res) => {
  const filePath = path.join(OUTPUT_DIR, `${req.params.jobId}.mp4`);
  try {
    await fs.access(filePath);
    cancelFileDeletion(filePath);
    res.download(filePath, 'gamerun_optimized.mp4', (err) => {
      if (!err) scheduleFileDeletion(filePath, 5, req.params.jobId);
    });
  } catch (err) {
    res.status(404).json({ error: 'File not found' });
  }
});

process.on('SIGTERM', () => {
  console.log('SIGTERM received');
  server.close(() => console.log('Server closed'));
});

let server;
ensureDirectories().then(() => {
  server = app.listen(PORT, '0.0.0.0', () => {
    console.log(`✓ Server on port ${PORT}`);
    console.log(`✓ Max upload: 5GB, 90-min videos supported`);
  });
}).catch(err => {
  console.error('Failed to start:', err);
  process.exit(1);
});
