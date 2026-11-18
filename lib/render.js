/**
 * 分段渲染引擎
 *
 * 核心设计：
 *  · 每个镜头渲染为独立 mp4 段落，参数完全一致，因此连续播放 == 成片
 *  · 段落按「内容指纹」缓存，内容没变就复用，改一个镜头只重渲那一段
 *  · 最后用 ffmpeg concat 拼接成整片
 *
 * 指纹 = 镜头素材 + 文稿 + 叠加参数（字幕、顶栏、章节）的哈希。
 * 任何一项变化都会导致该段重渲，其余段落不受影响。
 */
const fs = require("node:fs");
const fsp = require("node:fs/promises");
const path = require("node:path");
const os = require("node:os");
const crypto = require("node:crypto");
const { execFile } = require("node:child_process");
const footage = require("./footage");
const encodeArgs = footage.encodeArgs;

/** 找到可用的 ffmpeg */
function findFfmpeg() {
  const candidates = [
    process.env.FFMPEG_PATH,
    path.join(__dirname, "..", "bin", "ffmpeg"),   // 项目内置（install.sh 安装）
    "/opt/homebrew/bin/ffmpeg",
    "/usr/local/bin/ffmpeg",
    path.join(os.homedir(), ".clipdesk/bin/ffmpeg"),
  ].filter(Boolean);
  for (const c of candidates) {
    try { fs.accessSync(c, fs.constants.X_OK); return c; } catch { /* 继续找 */ }
  }
  // 退回 PATH 中的 ffmpeg
  return "ffmpeg";
}
const FFMPEG = findFfmpeg();

/** 找到 ffmpeg drawtext 可用的中文字体（跳过 PingFang.ttc 等纯集合格式） */
function findFont() {
  const candidates = [
    process.env.CLIPDESK_FONT,
    "/System/Library/Fonts/Hiragino Sans GB.ttc",
    "/System/Library/Fonts/STHeiti Medium.ttc",
    "/System/Library/Fonts/Supplemental/Songti.ttc",
    "/usr/share/fonts/truetype/noto/NotoSansCJK-Regular.ttc",
  ].filter(Boolean);
  for (const c of candidates) {
    try { fs.accessSync(c, fs.constants.R_OK); return c; } catch { /* next */ }
  }
  return null;
}
const FONT = findFont();

function run(cmd, args, opts = {}) {
  return new Promise((resolve, reject) => {
    execFile(cmd, args, { maxBuffer: 1024 * 1024 * 64, ...opts }, (err, stdout, stderr) => {
      if (err) {
        err.stderr = stderr;
        return reject(err);
      }
      resolve({ stdout, stderr });
    });
  });
}

/** 计算字符串/文件组合的短指纹 */
function fingerprint(parts) {
  const h = crypto.createHash("sha1");
  for (const p of parts) {
    if (p === null || p === undefined) continue;
    h.update(String(p));
    h.update("\u0000");
  }
  return h.digest("hex").slice(0, 16);
}

/** 读取视频/音频时长（秒） */
async function probeDuration(file) {
  try {
    const { stdout } = await run(FFMPEG, ["-hide_banner", "-i", file], {});
    return 0;
  } catch (e) {
    const out = String(e.stderr || "");
    const m = out.match(/Duration:\s*(\d+):(\d+):([\d.]+)/);
    if (m) return (+m[1]) * 3600 + (+m[2]) * 60 + parseFloat(m[3]);
    return 0;
  }
}

/**
 * 渲染单个镜头段落
 *
 * 两种素材来源：
 *  1. 文字卡（无录制素材时）：直接生成纯色背景 + 字幕
 *  2. 录制帧序列 + 点击效果：按时间映射取帧，叠加顶栏/字幕/指针
 *
 * @param {Object} shot     镜头定义
 * @param {Object} ctx      { segmentsDir, workDir, overlay }
 * @returns {Promise<{file:string, duration:number, cached:boolean}>}
 */
async function renderSegment(shot, ctx) {
  const segDir = ctx.segmentsDir;
  await fsp.mkdir(segDir, { recursive: true });

  const outFile = path.join(segDir, `${shot.id}.mp4`);
  const metaFile = path.join(segDir, `${shot.id}.json`);

  const voiceDur = shot.voice?.duration || 0;
  const duration = Math.max(0.5, shot.duration || voiceDur || 2);
  const W = ctx.width || 1600;
  const H = ctx.height || 900;
  const FPS = ctx.fps || 30;

  // 项目里是否有真实录屏素材
  const hasSrc = ctx.recording && ctx.recording.frames?.length && shot.footage;

  const fp = fingerprint([
    "v3",
    shot.id,
    shot.footage?.start,
    shot.footage?.end,
    shot.voice?.text,
    duration,
    hasSrc ? "footage" : "textcard",
    hasSrc ? ctx.recording.frames.length : 0,
    W, H, FPS,
    ctx.template || "classic",
  ]);

  // 缓存命中
  try {
    const meta = JSON.parse(await fsp.readFile(metaFile, "utf8"));
    if (meta.fingerprint === fp && fs.existsSync(outFile)) {
      return { file: outFile, duration: meta.duration, cached: true };
    }
  } catch { /* 无缓存 */ }

  if (hasSrc) {
    await renderFromFootage(shot, ctx, { outFile, duration, W, H, FPS });
  } else {
    await renderTextCard(shot, ctx, { outFile, duration, W, H, FPS });
  }

  // 把该镜头配音合进分段，使分段自带音轨
  // 好处：预览和导出都只需拼接，无需单独重建音轨
  await muxShotAudio(outFile, shot, ctx, duration);

  await fsp.writeFile(metaFile, JSON.stringify({
    id: shot.id, fingerprint: fp, duration, file: outFile,
    source: hasSrc ? "footage" : "textcard",
    renderedAt: new Date().toISOString(),
  }, null, 2), "utf8");

  return { file: outFile, duration, cached: false, source: hasSrc ? "footage" : "textcard" };
}

/**
 * 把镜头配音合进分段视频
 *
 * 配音时长与镜头时长不一致时，用 apad/atrim 补齐裁到镜头时长，
 * 保证音画严格对齐。
 */
async function muxShotAudio(videoFile, shot, ctx, duration) {
  const voiceFile = path.join(ctx.projectDir || "", "voice", `${shot.id}.wav`);
  if (!fs.existsSync(voiceFile)) return false;

  const tmpOut = videoFile + ".mux.mp4";
  try {
    await run(FFMPEG, [
      "-hide_banner", "-loglevel", "error", "-y",
      "-i", videoFile,
      "-i", voiceFile,
      "-filter_complex",
      `[1:a]apad,atrim=0:${duration.toFixed(3)},asetpts=PTS-STARTPTS[a]`,
      "-map", "0:v", "-map", "[a]",
      "-c:v", "copy", "-c:a", "aac", "-b:a", "128k", "-ar", "22050", "-ac", "1",
      "-shortest", tmpOut,
    ]);
    await fsp.rename(tmpOut, videoFile);
    return true;
  } catch (e) {
    await fsp.unlink(tmpOut).catch(() => {});
    return false;
  }
}

/** 用录屏素材合成真实画面 */
async function renderFromFootage(shot, ctx, { outFile, duration, W, H, FPS }) {
  const tmpDir = path.join(os.tmpdir(), `clipdesk-${shot.id}-${Date.now()}`);
  const jobFile = path.join(os.tmpdir(), `clipdesk-job-${shot.id}-${Date.now()}.json`);

  const job = {
    projectDir: ctx.projectDir,
    shot: {
      id: shot.id,
      duration,
      footage: shot.footage,
      voice: shot.voice,
      overlay: shot.overlay || {},
    },
    recording: ctx.recording,
    outDir: tmpDir,
    size: { width: W, height: H },
    fps: FPS,
    stages: ctx.stages || [],
    shots: ctx.allShots || [],
    brand: ctx.brand || {},
    template: ctx.template || null,
  };

  await fsp.writeFile(jobFile, JSON.stringify(job), "utf8");

  try {
    // 1. Python 合成帧
    await run("python3", [path.join(__dirname, "composite.py"), "--job", jobFile]);

    // 2. ffmpeg 编码
    await run(FFMPEG, [
      "-hide_banner", "-loglevel", "error", "-y",
      "-framerate", String(FPS),
      "-i", path.join(tmpDir, "%05d.png"),
      ...encodeArgs(FPS),
      outFile,
    ]);
  } finally {
    await fsp.rm(tmpDir, { recursive: true, force: true }).catch(() => {});
    await fsp.unlink(jobFile).catch(() => {});
  }
}

/** 无素材时生成纯色文字卡（降级方案） */
async function renderTextCard(shot, ctx, { outFile, duration, W, H, FPS }) {
  const text = (shot.voice?.text || "").replace(/[':]/g, " ");
  const fontFile = ctx.fontFile || FONT;
  const drawText = text && fontFile
    ? `drawtext=fontfile='${fontFile}':text='${text}':fontcolor=0xe8ecf8:fontsize=32:x=(w-text_w)/2:y=(h-text_h)/2:line_spacing=12`
    : null;
  const filters = [`color=c=0x0f1220:s=${W}x${H}:d=${duration}:r=${FPS}`, drawText].filter(Boolean).join(",");

  await run(FFMPEG, [
    "-hide_banner", "-loglevel", "error", "-y",
    "-f", "lavfi", "-i", filters,
    "-t", String(duration),
    ...encodeArgs(FPS),
    outFile,
  ]);
}

/**
 * 渲染全部段落
 * @param {Object} project
 * @param {Object} ctx
 * @param {Function} onProgress (index, total, shot, result) => void
 */
async function renderAllSegments(project, ctx, onProgress) {
  const results = [];
  const shots = project.shots || [];
  let rendered = 0, cached = 0;

  for (let i = 0; i < shots.length; i += 1) {
    const shot = shots[i];
    const r = await renderSegment(shot, ctx);
    results.push({ id: shot.id, ...r });
    if (r.cached) cached += 1; else rendered += 1;
    if (onProgress) onProgress(i, shots.length, shot, r, { rendered, cached });
  }

  return { segments: results, rendered, cached };
}

/**
 * 拼接段落为整片
 * @param {Array} segments [{file, duration}]
 * @param {string} outFile
 * @param {string} audioFile 可选：完整配音
 */
/**
 * 构建完整音轨：按镜头顺序把配音拼接起来，每段补齐到该镜头时长
 *
 * 为什么需要补齐：配音时长和镜头时长可能有差异（用户调过时长），
 * 直接用 concat 会导致音画逐渐错位。所以每段音频先补齐/裁剪到精确时长，
 * 再首尾相接，保证任何时刻的音画都是对齐的。
 *
 * @param {Array} audioSegs [{ file, duration, shotDuration }]
 * @param {string} outWav
 * @param {number} totalDuration
 * @param {string} workDir
 */
async function buildAudioTrack(audioSegs, outWav, totalDuration, workDir) {
  const valid = audioSegs.filter((a) => a.file && fs.existsSync(a.file));
  if (!valid.length) return null;

  await fsp.mkdir(workDir, { recursive: true });
  const listFile = path.join(workDir, "audio-list.txt");
  const lines = [];

  for (let i = 0; i < valid.length; i += 1) {
    const a = valid[i];
    const target = Math.max(0.1, a.shotDuration || a.duration || 1);
    const padded = path.join(workDir, `a${String(i).padStart(3, "0")}.wav`);

    // 用 apad 补齐、atrim 裁剪到精确时长，并统一采样率/声道
    await run(FFMPEG, [
      "-hide_banner", "-loglevel", "error", "-y",
      "-i", a.file,
      "-af", `apad,atrim=0:${target.toFixed(3)},asetpts=PTS-STARTPTS`,
      "-ar", "22050", "-ac", "1",
      padded,
    ]);
    lines.push(`file '${padded.replace(/'/g, "'\\''")}'`);
  }

  await fsp.writeFile(listFile, lines.join("\n") + "\n", "utf8");
  await run(FFMPEG, [
    "-hide_banner", "-loglevel", "error", "-y",
    "-f", "concat", "-safe", "0", "-i", listFile,
    "-t", String(totalDuration.toFixed(3)),
    "-ar", "22050", "-ac", "1",
    outWav,
  ]);

  await fsp.unlink(listFile).catch(() => {});
  for (const l of lines) {
    const f = l.replace(/^file '|'$/g, "").replace(/'\\''/g, "'");
    await fsp.unlink(f).catch(() => {});
  }
  return outWav;
}

async function concatSegments(segments, outFile, audioFile) {
  const listFile = outFile + ".txt";
  const lines = segments.map((s) => `file '${s.file.replace(/'/g, "'\\''")}'`);
  await fsp.writeFile(listFile, lines.join("\n") + "\n", "utf8");

  const args = [
    "-hide_banner", "-loglevel", "error", "-y",
    "-f", "concat", "-safe", "0", "-i", listFile,
  ];
  if (audioFile && fs.existsSync(audioFile)) {
    // 外部音轨优先（旧方式：单独合成的完整音轨）
    args.push("-i", audioFile, "-map", "0:v", "-map", "1:a",
      "-c:a", "aac", "-b:a", "128k");
  } else {
    // 分段自带音轨：直接保留 concat 出来的两路流
    args.push("-map", "0:v", "-map", "0:a?", "-c:a", "aac", "-b:a", "128k");
  }
  args.push(
    "-c:v", "libx264", "-preset", "veryfast", "-crf", "22",
    "-pix_fmt", "yuv420p", "-r", "30", "-movflags", "+faststart",
    outFile,
  );

  await run(FFMPEG, args);
  await fsp.unlink(listFile).catch(() => {});
  return outFile;
}

module.exports = {
  FONT,
  encodeArgs: footage.encodeArgs,
  renderSegment,
  renderAllSegments,
  concatSegments,
  buildAudioTrack,
  probeDuration,
  fingerprint,
  FFMPEG,
  findFfmpeg,
};
