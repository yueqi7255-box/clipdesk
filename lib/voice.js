/**
 * 配音生成（macOS say + afconvert）
 *
 * 每段配音独立生成 wav，按镜头缓存。文稿改动只重生成对应段落。
 */
const fs = require("node:fs");
const fsp = require("node:fs/promises");
const path = require("node:path");
const crypto = require("node:crypto");
const { execFile } = require("node:child_process");

const DEFAULT_VOICE = "Lilian (Premium)";
const DEFAULT_RATE = 180;

function run(cmd, args) {
  return new Promise((resolve, reject) => {
    execFile(cmd, args, (err, stdout, stderr) => {
      if (err) { err.stderr = stderr; return reject(err); }
      resolve({ stdout, stderr });
    });
  });
}

/** 检查 say 是否可用（仅 macOS） */
async function isAvailable() {
  try {
    await run("say", ["-v", "?"]);
    return true;
  } catch {
    return false;
  }
}

/** 用 afinfo 读取音频时长 */
async function audioDuration(file) {
  try {
    const { stdout } = await run("afinfo", [file]);
    const m = stdout.match(/estimated duration:\s*([\d.]+)/);
    return m ? parseFloat(m[1]) : 0;
  } catch {
    return 0;
  }
}

/**
 * 生成单个镜头的配音
 * @returns {Promise<{file, duration, cached}>}
 */
async function synthSegment(shotId, text, opts = {}) {
  const dir = opts.voiceDir;
  await fsp.mkdir(dir, { recursive: true });

  const voice = opts.voice || DEFAULT_VOICE;
  const rate = opts.rate || DEFAULT_RATE;

  const fp = crypto.createHash("sha1")
    .update(`${voice}|${rate}|${text}`).digest("hex").slice(0, 16);

  const metaFile = path.join(dir, `${shotId}.json`);
  const wavFile = path.join(dir, `${shotId}.wav`);

  // 缓存命中
  try {
    const meta = JSON.parse(await fsp.readFile(metaFile, "utf8"));
    if (meta.fingerprint === fp && fs.existsSync(wavFile)) {
      return { file: wavFile, duration: meta.duration, cached: true };
    }
  } catch { /* 无缓存 */ }

  const aiff = path.join(dir, `${shotId}.aiff`);
  await run("say", ["-v", voice, "-r", String(rate), "-o", aiff, text]);
  await run("afconvert", ["-f", "WAVE", "-d", "LEI16@22050", aiff, wavFile]);
  await fsp.unlink(aiff).catch(() => {});

  const duration = await audioDuration(wavFile);

  await fsp.writeFile(metaFile, JSON.stringify({
    id: shotId, fingerprint: fp, voice, rate, text, duration,
    renderedAt: new Date().toISOString(),
  }, null, 2), "utf8");

  return { file: wavFile, duration, cached: false };
}

/**
 * 生成全部配音并合成完整音轨
 * @returns {Promise<{segments, totalDuration, voiceFile}>}
 */
async function synthAll(project, opts = {}, onProgress) {
  const shots = project.shots || [];
  const dir = opts.voiceDir;
  const results = [];
  let total = 0;

  for (let i = 0; i < shots.length; i += 1) {
    const shot = shots[i];
    const text = shot.voice?.text || "";
    if (!text) {
      results.push({ id: shot.id, duration: shot.duration || 1, file: null });
      total += shot.duration || 1;
      continue;
    }
    const r = await synthSegment(shot.id, text, opts);
    results.push({ id: shot.id, ...r });
    total += r.duration + (opts.gap ?? 0.35);
    if (onProgress) onProgress(i, shots.length, shot, r);
  }

  return { segments: results, totalDuration: total };
}

module.exports = { synthSegment, synthAll, audioDuration, isAvailable, DEFAULT_VOICE, DEFAULT_RATE };
