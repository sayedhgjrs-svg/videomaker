require('dotenv').config();
const express = require('express');
const { spawn } = require('child_process');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

// ---------- الإعدادات (من ملف .env) ----------
const CFG = {
  port: +process.env.PORT || 3000,
  pexelsKey: process.env.PEXELS_KEY || '',
  maxPerIpDay: +process.env.MAX_PER_IP_DAY || 3,
  maxSiteDay: +process.env.MAX_SITE_DAY || 100,
  maxQueue: +process.env.MAX_QUEUE || 5,
  maxChars: +process.env.MAX_CHARS || 600,
  keepMinutes: +process.env.KEEP_MINUTES || 60,
  edgeTts: process.env.EDGE_TTS_BIN || path.join(process.env.HOME || '/home/ubuntu', '.local/bin/edge-tts'),
  trustProxy: process.env.TRUST_PROXY === '1',
};

const TMP = path.join(__dirname, 'tmp');
const OUT = path.join(__dirname, 'out');
fs.mkdirSync(TMP, { recursive: true });
fs.mkdirSync(OUT, { recursive: true });

const VOICES = {
  ar: ['ar-EG-SalmaNeural', 'ar-EG-ShakirNeural', 'ar-SA-HamedNeural', 'ar-SA-ZariyahNeural'],
  en: ['en-US-AndrewMultilingualNeural', 'en-US-AriaNeural', 'en-US-GuyNeural', 'en-US-JennyNeural'],
};
const COLORS = ['0x1b2a49', '0x2d1b3d', '0x143d3a', '0x3b2a1a', '0x1f1f3d'];

// ---------- الحدود اليومية ----------
let dayKey = new Date().toDateString();
let siteCount = 0;
const ipCount = new Map();

function rollDay() {
  const k = new Date().toDateString();
  if (k !== dayKey) { dayKey = k; siteCount = 0; ipCount.clear(); }
}

// ---------- الطابور ----------
const jobs = new Map();
const queue = [];
let working = false;

function run(cmd, args, opts = {}) {
  return new Promise((resolve, reject) => {
    const p = spawn(cmd, args, { cwd: opts.cwd, env: process.env });
    let err = '';
    const timer = setTimeout(() => { p.kill('SIGKILL'); reject(new Error('timeout: ' + cmd)); }, opts.timeout || 240000);
    p.stderr.on('data', d => { err += d.toString(); if (err.length > 4000) err = err.slice(-4000); });
    p.on('error', e => { clearTimeout(timer); reject(e); });
    p.on('close', code => {
      clearTimeout(timer);
      code === 0 ? resolve(err) : reject(new Error(`${cmd} exit ${code}: ${err.slice(-500)}`));
    });
  });
}

function probeDuration(file) {
  return new Promise((resolve, reject) => {
    const p = spawn('ffprobe', ['-v', 'error', '-show_entries', 'format=duration', '-of', 'default=nw=1:nk=1', file]);
    let out = '';
    p.stdout.on('data', d => (out += d));
    p.on('close', () => { const n = parseFloat(out); n > 0 ? resolve(n) : reject(new Error('no duration')); });
  });
}

async function fetchPexels(keyword, count, dir) {
  if (!CFG.pexelsKey || !keyword) return [];
  try {
    const url = `https://api.pexels.com/v1/search?query=${encodeURIComponent(keyword)}&orientation=portrait&per_page=${count}`;
    const r = await fetch(url, { headers: { Authorization: CFG.pexelsKey } });
    if (!r.ok) return [];
    const data = await r.json();
    const files = [];
    for (const [i, ph] of (data.photos || []).slice(0, count).entries()) {
      const img = await fetch(ph.src.portrait);
      if (!img.ok) continue;
      const f = path.join(dir, `img${i}.jpg`);
      fs.writeFileSync(f, Buffer.from(await img.arrayBuffer()));
      files.push(`img${i}.jpg`);
    }
    return files;
  } catch (e) {
    console.error('pexels error:', e.message);
    return [];
  }
}

async function processJob(job) {
  const dir = path.join(TMP, job.id);
  fs.mkdirSync(dir, { recursive: true });
  try {
    // 1) الصوت + الترجمة
    job.step = 'voice';
    fs.writeFileSync(path.join(dir, 'text.txt'), job.text, 'utf8');
    await run(CFG.edgeTts, ['--voice', job.voice, '--file', 'text.txt',
      '--write-media', 'voice.mp3', '--write-subtitles', 'subs.srt'], { cwd: dir, timeout: 90000 });
    const dur = await probeDuration(path.join(dir, 'voice.mp3'));
    if (dur > 75) throw new Error('الفيديو أطول من الحد المسموح');

    // 2) الخلفيات
    job.step = 'images';
    const n = Math.min(8, Math.max(3, Math.ceil(dur / 6)));
    const imgs = await fetchPexels(job.keyword, n, dir);

    // 3) التجميع
    job.step = 'render';
    const sub = "subtitles=subs.srt:force_style='FontName=Noto Sans Arabic,FontSize=15,Bold=1,Alignment=2,MarginV=140,Outline=2,Shadow=0,PrimaryColour=&H00FFFFFF'";
    const vf = `scale=720:1280:force_original_aspect_ratio=increase,crop=720:1280,fps=25,${sub},format=yuv420p`;
    let input;
    if (imgs.length) {
      const per = dur / imgs.length;
      let list = '';
      imgs.forEach(f => { list += `file '${f}'\nduration ${per.toFixed(3)}\n`; });
      list += `file '${imgs[imgs.length - 1]}'\n`;
      fs.writeFileSync(path.join(dir, 'list.txt'), list);
      input = ['-f', 'concat', '-safe', '0', '-i', 'list.txt'];
    } else {
      const c = COLORS[Math.floor(Math.random() * COLORS.length)];
      input = ['-f', 'lavfi', '-i', `color=c=${c}:s=720x1280:r=25:d=${(dur + 0.5).toFixed(2)}`];
    }
    const outName = `${job.id}.mp4`;
    await run('ffmpeg', ['-y', '-threads', '1', ...input, '-i', 'voice.mp3',
      '-vf', vf, '-c:v', 'libx264', '-preset', 'ultrafast', '-crf', '28',
      '-c:a', 'aac', '-b:a', '96k', '-shortest', '-movflags', '+faststart',
      path.join(OUT, outName)], { cwd: dir, timeout: 300000 });

    job.status = 'done';
    job.url = `/videos/${outName}`;
  } catch (e) {
    console.error(`[job ${job.id}]`, e.message);
    job.status = 'error';
    job.error = 'تعذّر إنشاء الفيديو. جرّب نصًا أقصر أو حاول بعد قليل.';
    ipCount.set(job.ip, Math.max(0, (ipCount.get(job.ip) || 1) - 1));
    siteCount = Math.max(0, siteCount - 1);
  } finally {
    fs.rm(dir, { recursive: true, force: true }, () => {});
  }
}

async function pump() {
  if (working) return;
  working = true;
  while (queue.length) {
    const job = jobs.get(queue.shift());
    if (!job) continue;
    job.status = 'processing';
    await processJob(job);
  }
  working = false;
}

// ---------- السيرفر ----------
const app = express();
if (CFG.trustProxy) app.set('trust proxy', 1);
app.use(express.json({ limit: '20kb' }));
app.use(express.static(path.join(__dirname, 'public')));
app.use('/videos', express.static(OUT, { maxAge: 0 }));

app.get('/api/info', (req, res) => {
  rollDay();
  const used = ipCount.get(req.ip) || 0;
  res.json({
    maxChars: CFG.maxChars,
    perIp: CFG.maxPerIpDay,
    left: Math.max(0, CFG.maxPerIpDay - used),
    voices: VOICES,
  });
});

app.post('/api/generate', (req, res) => {
  rollDay();
  const { text, lang, voice, keyword } = req.body || {};
  const clean = String(text || '').replace(/\s+/g, ' ').trim();

  if (!clean) return res.status(400).json({ error: 'اكتب النص الأول.' });
  if (clean.length > CFG.maxChars) return res.status(400).json({ error: `النص أطول من ${CFG.maxChars} حرف.` });
  if (!VOICES[lang]) return res.status(400).json({ error: 'لغة غير مدعومة.' });
  const v = VOICES[lang].includes(voice) ? voice : VOICES[lang][0];

  if ((ipCount.get(req.ip) || 0) >= CFG.maxPerIpDay)
    return res.status(429).json({ error: `وصلت لحدك اليومي (${CFG.maxPerIpDay} فيديوهات). ارجع بكرة.` });
  if (siteCount >= CFG.maxSiteDay)
    return res.status(429).json({ error: 'الموقع وصل للحد اليومي. جرّب بكرة.' });
  if (queue.length >= CFG.maxQueue)
    return res.status(503).json({ error: 'الموقع مشغول الآن. جرّب بعد دقائق.' });

  const id = crypto.randomBytes(8).toString('hex');
  const job = {
    id, ip: req.ip, text: clean, voice: v,
    keyword: String(keyword || '').replace(/[^\p{L}\p{N} ]/gu, '').slice(0, 40).trim(),
    status: 'queued', step: '', created: Date.now(),
  };
  jobs.set(id, job);
  queue.push(id);
  ipCount.set(req.ip, (ipCount.get(req.ip) || 0) + 1);
  siteCount++;
  pump();
  res.json({ id });
});

app.get('/api/status/:id', (req, res) => {
  const job = jobs.get(req.params.id);
  if (!job) return res.status(404).json({ error: 'الطلب غير موجود أو انتهت صلاحيته.' });
  res.json({
    status: job.status,
    step: job.step,
    position: Math.max(0, queue.indexOf(job.id) + 1),
    url: job.url,
    error: job.error,
  });
});

// ---------- مسح تلقائي ----------
setInterval(() => {
  const cutoff = Date.now() - CFG.keepMinutes * 60000;
  for (const [id, j] of jobs) if (j.created < cutoff && j.status !== 'processing') jobs.delete(id);
  for (const dir of [OUT, TMP]) {
    for (const f of fs.readdirSync(dir)) {
      const p = path.join(dir, f);
      try { if (fs.statSync(p).mtimeMs < cutoff) fs.rmSync(p, { recursive: true, force: true }); } catch {}
    }
  }
}, 10 * 60000);

app.listen(CFG.port, () => console.log(`Server running on port ${CFG.port}`));