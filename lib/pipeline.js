/**
 * 渲染流水线 · CLI 与服务端共用
 *
 * 设计原则：渲染不依赖 Web 服务，CLI 可直接执行。
 * 服务端只是把它包成异步任务供界面轮询。
 */
const fs = require("node:fs");
const fsp = require("node:fs/promises");
const path = require("node:path");

const ws = require("./workspace");
const render = require("./render");
const voice = require("./voice");
const footage = require("./footage");

/**
 * 为一个工作区渲染新版本
 *
 * @param {string} wsId 工作区 id
 * @param {Object} opts
 *   - skipVoice: 跳过配音生成（复用已有）
 *   - only: 只渲染指定镜头（数组），其余复用缓存
 *   - onProgress(stage, pct, message)
 * @returns {Promise<{version, duration, file, rendered, cached}>}
 */
async function renderWorkspace(wsId, opts = {}) {
  const onProgress = opts.onProgress || (() => {});
  const project = await ws.getProject(wsId);
  const base = await ws.resolveFile(wsId, ".");

  // ── 1. 配音 ──
  if (!opts.skipVoice) {
    onProgress("voice", 2, "生成配音…");
    const vr = await voice.synthAll(project, {
      voiceDir: path.join(base, "voice"),
      voice: project.config?.voiceName,
      rate: project.config?.voiceRate,
    }, (i, total, shot, r) => {
      onProgress("voice", 2 + Math.round((i + 1) / total * 26),
        `${shot.id} ${r.cached ? "复用" : "生成"} ${r.duration.toFixed(1)}s`);
    });

    // 回写时长
    for (const seg of vr.segments) {
      const shot = project.shots.find((s) => s.id === seg.id);
      if (shot) {
        shot.voice = shot.voice || {};
        shot.voice.duration = seg.duration;
        shot.duration = seg.duration;
      }
    }
    await ws.saveProject(wsId, project);
  }

  // ── 2. 分段渲染 ──
  onProgress("segments", 30, "准备渲染…");
  const rec = await footage.loadRecording(path.join(base, "footage"));
  const ctx = {
    segmentsDir: path.join(base, "segments"),
    projectDir: base,
    recording: rec,
    stages: project.config?.stages || [],
    allShots: project.shots,
    brand: project.config?.brand || { title: project.name, sub: "" },
    template: project.config?.template || "classic",
    width: project.config?.size?.width || 1600,
    height: project.config?.size?.height || 900,
    fps: project.config?.fps || 30,
  };

  const segResult = await render.renderAllSegments(project, ctx,
    (i, total, shot, r, stats) => {
      onProgress("segments", 30 + Math.round((i + 1) / total * 55),
        `${shot.id} ${r.cached ? "复用" : "渲染"} · 新渲 ${stats.rendered} / 复用 ${stats.cached}`);
    });

  // ── 3. 拼接 ──
  onProgress("concat", 88, "拼接整片…");
  const segs = [];
  for (const shot of project.shots) {
    const f = path.join(base, "segments", `${shot.id}.mp4`);
    if (fs.existsSync(f)) segs.push({ file: f, duration: shot.duration });
  }
  if (!segs.length) throw new Error("没有可拼接的段落");

  // 构建完整音轨（按镜头顺序拼接配音）
  onProgress("audio", 86, "构建音轨…");
  const audioSegs = project.shots.map((shot) => ({
    file: path.join(base, "voice", `${shot.id}.wav`),
    duration: shot.voice?.duration || 0,
    shotDuration: shot.duration || 1,
  }));
  const audioTmp = path.join(base, "segments", ".audio-tmp");
  const hasVoice = audioSegs.some((a) => fs.existsSync(a.file));
  let audioFile = null;
  if (hasVoice) {
    audioFile = await render.buildAudioTrack(audioSegs, path.join(base, "segments", "audio.wav"),
      segs.reduce((sum, x) => sum + (x.duration || 0), 0), audioTmp);
  }

  const versionNo = (project.currentVersion || 0) + 1;
  const verDir = path.join(base, "versions", `v${versionNo}`);
  await fsp.mkdir(verDir, { recursive: true });
  const outFile = path.join(verDir, "video.mp4");

  await render.concatSegments(segs, outFile, audioFile);
  await fsp.rm(audioTmp, { recursive: true, force: true }).catch(() => {});
  const duration = await render.probeDuration(outFile);

  // ── 4. 记录版本 ──
  onProgress("version", 96, "记录版本…");
  project.currentVersion = versionNo;
  project.versions = project.versions || [];
  project.versions.push({
    version: versionNo,
    file: path.relative(base, outFile),
    createdAt: new Date().toISOString(),
    shots: project.shots.map((s) => ({ id: s.id, text: s.voice?.text || "" })),
  });
  while (project.versions.length > 5) {
    const old = project.versions.shift();
    await fsp.rm(path.join(base, "versions", `v${old.version}`), { recursive: true, force: true }).catch(() => {});
  }
  project.config = project.config || {};
  project.config.videoFile = path.relative(base, outFile);
  project.config.totalDuration = duration;
  await ws.saveProject(wsId, project);

  onProgress("done", 100, `完成 · v${versionNo}`);
  return {
    version: versionNo,
    duration,
    file: project.config.videoFile,
    rendered: segResult.rendered,
    cached: segResult.cached,
    total: segResult.segments.length,
  };
}

/**
 * 生成缩略图（带缓存）
 *
 * 关键：只用一次 ffmpeg 调用批量抽取所有帧，而不是每个镜头各起一次进程。
 * 24 个镜头单独抽帧要 60 秒以上，批量抽只要 2-3 秒。
 *
 * 缓存策略：把成片的 mtime + 镜头时间点算成指纹，存进 thumbs/index.json。
 * 成片没变、镜头没变，就直接返回已有缩略图。
 */
async function generateThumbs(wsId, opts = {}) {
  const project = await ws.getProject(wsId);
  const base = await ws.resolveFile(wsId, ".");
  const vid = project.config?.videoFile;
  if (!vid) throw new Error("尚未合成，无法生成缩略图");

  const videoPath = path.join(base, vid);
  if (!fs.existsSync(videoPath)) throw new Error("成片文件不存在");

  const thumbDir = path.join(base, "thumbs");
  await fsp.mkdir(thumbDir, { recursive: true });
  const indexPath = path.join(thumbDir, "index.json");

  // ── 计算指纹：成片修改时间 + 镜头时间点 ──
  const stat = await fsp.stat(videoPath);
  const times = [];
  let acc = 0;
  for (const shot of project.shots) {
    times.push({ id: shot.id, t: +(acc + Math.min(shot.duration * 0.5, shot.duration - 0.1)).toFixed(3) });
    acc += shot.duration || 1;
  }
  const fp = require("node:crypto").createHash("sha1")
    .update(`${stat.mtimeMs}|${stat.size}|${JSON.stringify(times)}`)
    .digest("hex").slice(0, 16);

  // ── 缓存命中 ──
  if (!opts.force) {
    try {
      const idx = JSON.parse(await fsp.readFile(indexPath, "utf8"));
      if (idx.fingerprint === fp && idx.thumbs?.every((t) => fs.existsSync(path.join(base, t.file)))) {
        return idx.thumbs;
      }
    } catch { /* 无缓存 */ }
  }

  // ── 一次调用批量抽帧 ──
  const { execFile } = require("node:child_process");
  const results = [];

  // ffmpeg 的 select 过滤器：在多个时间点抽取帧
  // 用 -vf select + fps 组合不可行（时间点不规则），改用多次 -ss 但共用一次输入
  // 这里用最简单可靠的方式：单个 ffmpeg 进程 + 多个输出
  const args = ["-hide_banner", "-loglevel", "error", "-y", "-i", videoPath];
  for (let i = 0; i < times.length; i += 1) {
    const out = path.join(thumbDir, `${times[i].id}.jpg`);
    args.push("-ss", String(times[i].t), "-frames:v", "1", "-vf", "scale=160:-1", "-q:v", "5", out);
    results.push({ id: times[i].id, file: path.relative(base, out) });
  }

  await new Promise((resolve, reject) => {
    execFile(render.FFMPEG, args, { maxBuffer: 1024 * 1024 * 16 }, (err) => {
      if (err) return reject(err);
      resolve();
    });
  });

  // 校验结果
  for (const r of results) {
    if (!fs.existsSync(path.join(base, r.file))) r.file = null;
  }

  await fsp.writeFile(indexPath, JSON.stringify({ fingerprint: fp, thumbs: results }, null, 2), "utf8");
  return results;
}

module.exports = { renderWorkspace, generateThumbs };
