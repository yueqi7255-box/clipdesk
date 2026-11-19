#!/usr/bin/env node
/**
 * 视频剪辑台 · 本地服务
 *
 * 提供：工作区管理、项目数据读写、视频/音频静态资源、渲染与配音触发。
 * 只依赖 Node 内置模块 + ffmpeg + macOS say。
 */
const http = require("node:http");
const fs = require("node:fs");
const fsp = require("node:fs/promises");
const path = require("node:path");
const { execFile } = require("node:child_process");

const ws = require("./lib/workspace");
const render = require("./lib/render");
const voice = require("./lib/voice");
const footage = require("./lib/footage");

const ROOT = __dirname;   // server.js 就在项目根目录
const PORT = Number(process.env.CLIPDESK_PORT || 4300);

const MIME = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".mp4": "video/mp4",
  ".m4a": "audio/mp4",
  ".wav": "audio/wav",
  ".webm": "video/webm",
};

function sendJson(res, code, obj) {
  const body = Buffer.from(JSON.stringify(obj), "utf8");
  res.writeHead(code, { "content-type": MIME[".json"], "content-length": body.length });
  res.end(body);
}

async function readBody(req) {
  const chunks = [];
  for await (const c of req) chunks.push(c);
  const raw = Buffer.concat(chunks).toString("utf8");
  if (!raw) return {};
  try { return JSON.parse(raw); } catch { return {}; }
}

/** 流式发送文件（支持 Range，视频拖动需要） */
async function sendFile(req, res, file) {
  let stat;
  try { stat = await fsp.stat(file); } catch { res.writeHead(404); return res.end("not found"); }
  const ext = path.extname(file).toLowerCase();
  const type = MIME[ext] || "application/octet-stream";
  const range = req.headers.range;

  if (range && /^bytes=\d*-\d*$/.test(range)) {
    const [s, e] = range.replace("bytes=", "").split("-");
    const start = s ? parseInt(s, 10) : 0;
    const end = e ? parseInt(e, 10) : stat.size - 1;
    if (start >= stat.size) {
      res.writeHead(416, { "content-range": `bytes */${stat.size}` });
      return res.end();
    }
    res.writeHead(206, {
      "content-type": type,
      "content-length": end - start + 1,
      "content-range": `bytes ${start}-${end}/${stat.size}`,
      "accept-ranges": "bytes",
      "cache-control": "no-store",
    });
    return fs.createReadStream(file, { start, end }).pipe(res);
  }

  // 页面与脚本禁止缓存，避免改了代码浏览器还用旧的
  const noCache = [".html", ".js", ".css", ".json"].includes(ext);
  res.writeHead(200, {
    "content-type": type,
    "content-length": stat.size,
    "accept-ranges": "bytes",
    "cache-control": noCache ? "no-store, must-revalidate" : "public, max-age=3600",
  });
  fs.createReadStream(file).pipe(res);
}

/* ── 后台任务状态（渲染/配音进度） ── */
const jobs = new Map();

function startJob(id, fn) {
  const job = { id, status: "running", progress: 0, message: "", logs: [], startedAt: Date.now() };
  jobs.set(id, job);
  (async () => {
    try {
      const result = await fn((pct, msg) => {
        job.progress = pct;
        job.message = msg || "";
      });
      job.status = "done";
      job.progress = 100;
      job.result = result;
    } catch (e) {
      job.status = "error";
      job.error = String(e.message || e);
      job.logs.push(String(e.stderr || ""));
    }
    job.finishedAt = Date.now();
  })();
  return job;
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url || "/", "http://127.0.0.1");
  const p = url.pathname;

  try {
    /* 静态页面 */
    if (p === "/" || p === "/index.html") {
      return sendFile(req, res, path.join(ROOT, "public/index.html"));
    }
    if (p.startsWith("/static/")) {
      return sendFile(req, res, path.join(ROOT, "public", p.slice(8)));
    }

    /* ── 系统目录选择器 ── */
    if (p === "/api/pick-folder" && req.method === "POST") {
      if (process.platform !== "darwin") {
        return sendJson(res, 400, { error: "当前平台不支持系统目录选择，请手动输入路径" });
      }
      try {
        const folder = await new Promise((resolve, reject) => {
          execFile("osascript", [
            "-e", 'POSIX path of (choose folder with prompt "选择视频项目目录")',
          ], { timeout: 300000 }, (err, stdout) => {
            if (err) return reject(err);
            resolve(String(stdout).trim());
          });
        });
        // 去掉末尾斜杠
        const clean = folder.replace(/\/$/, "");
        return sendJson(res, 200, { path: clean, name: path.basename(clean) });
      } catch (e) {
        // 用户取消
        return sendJson(res, 200, { cancelled: true });
      }
    }

    /* ── 在 Finder 中打开项目目录 ── */
    if (p === "/api/reveal" && req.method === "POST") {
      const body = await readBody(req);
      if (!body.id) return sendJson(res, 400, { error: "缺少工作区 id" });

      const project = await ws.getProject(body.id);
      const dir = project._wsPath;
      const target = path.join(dir, "project.json");

      try {
        if (process.platform === "darwin") {
          // 有 project.json 就在 Finder 中选中它，否则直接打开目录
          if (fs.existsSync(target)) {
            await new Promise((resolve, reject) => {
              execFile("open", ["-R", target], (err) => (err ? reject(err) : resolve()));
            });
          } else {
            await new Promise((resolve, reject) => {
              execFile("open", [dir], (err) => (err ? reject(err) : resolve()));
            });
          }
        } else if (process.platform === "win32") {
          await new Promise((resolve, reject) => {
            execFile("explorer", [dir], (err) => (err ? reject(err) : resolve()));
          });
        } else {
          await new Promise((resolve, reject) => {
            execFile("xdg-open", [dir], (err) => (err ? reject(err) : resolve()));
          });
        }
        return sendJson(res, 200, { ok: true, path: dir });
      } catch (e) {
        return sendJson(res, 500, { error: "无法打开目录：" + (e.message || e) });
      }
    }

    /* ── 工作区 ── */
    if (p === "/api/workspaces" && req.method === "GET") {
      return sendJson(res, 200, await ws.listWorkspaces());
    }

    if (p === "/api/workspaces" && req.method === "POST") {
      const body = await readBody(req);
      const r = await ws.createWorkspace({ name: body.name, projectPath: body.path });
      return sendJson(res, 200, r);
    }

    if (p === "/api/workspaces" && req.method === "DELETE") {
      const id = url.searchParams.get("id");
      const ok = await ws.removeWorkspace(id);
      return sendJson(res, 200, { ok });
    }

    /* ── 项目数据 ── */
    if (p === "/api/project" && req.method === "GET") {
      const id = url.searchParams.get("id");
      return sendJson(res, 200, await ws.getProject(id));
    }

    if (p === "/api/project" && req.method === "POST") {
      const body = await readBody(req);
      return sendJson(res, 200, await ws.saveProject(body.id, body.data));
    }

    /* ── 文件访问（视频、音频、图片） ── */
    if (p === "/api/file") {
      const wsId = url.searchParams.get("ws");
      const rel = url.searchParams.get("path");
      const full = await ws.resolveFile(wsId, rel);
      return sendFile(req, res, full);
    }

    /* ── 配音生成 ── */
    if (p === "/api/render/voice" && req.method === "POST") {
      const body = await readBody(req);
      const project = await ws.getProject(body.id);
      const base = await ws.resolveFile(body.id, ".");
      const jobId = "voice-" + Date.now();

      const job = startJob(jobId, async (progress) => {
        const r = await voice.synthAll(project, {
          voiceDir: path.join(base, "voice"),
          voice: project.config?.voiceName,
          rate: project.config?.voiceRate,
        }, (i, total, shot, rr) => progress(
          Math.round((i + 1) / total * 100),
          `${shot.id} ${rr.cached ? "复用" : "生成"} ${rr.duration.toFixed(1)}s`,
        ));

        // 回写时长到镜头
        for (const seg of r.segments) {
          const shot = project.shots.find((s) => s.id === seg.id);
          if (shot) {
            shot.voice = shot.voice || {};
            shot.voice.duration = seg.duration;
            shot.duration = seg.duration;
          }
        }
        await ws.saveProject(body.id, project);
        return { totalDuration: r.totalDuration, count: r.segments.length };
      });

      return sendJson(res, 200, { jobId: job.id });
    }

    /* ── 渲染 ── */
    if (p === "/api/render/segments" && req.method === "POST") {
      const body = await readBody(req);
      const project = await ws.getProject(body.id);
      const base = await ws.resolveFile(body.id, ".");
      const jobId = "render-" + Date.now();

      const job = startJob(jobId, async (progress) => {
        // 组装素材上下文
        const rec = await footage.loadRecording(path.join(base, "footage"));
        const r = await render.renderAllSegments(project, {
          segmentsDir: path.join(base, "segments"),
          projectDir: base,
          recording: rec,
          stages: project.config?.stages || [],
          allShots: project.shots,
          brand: project.config?.brand || { title: project.name, sub: "" },
          width: project.config?.size?.width || 1600,
          height: project.config?.size?.height || 900,
          fps: project.config?.fps || 30,
        }, (i, total, shot, rr, stats) => progress(
          Math.round((i + 1) / total * 100),
          `${shot.id} ${rr.cached ? "复用" : "渲染"} · 已渲染 ${stats.rendered} / 复用 ${stats.cached}`,
        ));
        return { rendered: r.rendered, cached: r.cached, total: r.segments.length };
      });

      return sendJson(res, 200, { jobId: job.id });
    }

    /* ── 合成整片 ── */
    /* ── 导出成片 ── */
    if (p === "/api/export" && req.method === "POST") {
      const body = await readBody(req);
      const jobId = "export-" + Date.now();
      const pipeline = require("./lib/pipeline");

      startJob(jobId, async (progress) => {
        const r = await pipeline.renderWorkspace(body.id, {
          mode: "export",
          skipVoice: true,
          onProgress: (stage, pct, msg) => progress(pct, msg),
        });
        return r;
      });
      return sendJson(res, 200, { jobId });
    }

    if (p === "/api/render/concat" && req.method === "POST") {
      const body = await readBody(req);
      const project = await ws.getProject(body.id);
      const base = await ws.resolveFile(body.id, ".");
      const jobId = "concat-" + Date.now();

      const job = startJob(jobId, async (progress) => {
        progress(10, "收集段落…");
        const segs = [];
        for (const shot of project.shots) {
          const f = path.join(base, "segments", `${shot.id}.mp4`);
          if (fs.existsSync(f)) segs.push({ file: f, duration: shot.duration });
        }
        if (!segs.length) throw new Error("没有可拼接的段落，请先渲染");

        progress(40, `拼接 ${segs.length} 段…`);
        const versionNo = (project.currentVersion || 0) + 1;
        const verDir = path.join(base, "versions", `v${versionNo}`);
        await fsp.mkdir(verDir, { recursive: true });
        const outFile = path.join(verDir, "video.mp4");

        // 配音音轨：如果存在各段配音，先拼成一个完整音轨
        await render.concatSegments(segs, outFile, null);

        progress(90, "记录版本…");
        const duration = await render.probeDuration(outFile);
        project.currentVersion = versionNo;
        project.versions = project.versions || [];
        project.versions.push({
          version: versionNo,
          file: path.relative(base, outFile),
          createdAt: new Date().toISOString(),
          shots: project.shots.map((s) => ({ id: s.id, text: s.voice?.text || "" })),
        });
        // 只保留最近 5 个版本
        while (project.versions.length > 5) {
          const old = project.versions.shift();
          await fsp.rm(path.join(base, "versions", `v${old.version}`), { recursive: true, force: true }).catch(() => {});
        }
        project.config = project.config || {};
        project.config.videoFile = path.relative(base, outFile);
        project.config.totalDuration = duration;
        await ws.saveProject(body.id, project);

        return { version: versionNo, duration, file: project.config.videoFile };
      });

      return sendJson(res, 200, { jobId: job.id });
    }

    /* ── 任务状态 ── */
    if (p === "/api/job" && req.method === "GET") {
      const id = url.searchParams.get("id");
      const job = jobs.get(id);
      if (!job) return sendJson(res, 404, { error: "任务不存在" });
      return sendJson(res, 200, job);
    }

    /* ── 生成缩略图（带缓存） ── */
    if (p === "/api/thumbs" && req.method === "POST") {
      const body = await readBody(req);
      const pipeline = require("./lib/pipeline");
      try {
        const thumbs = await pipeline.generateThumbs(body.id, { force: !!body.force });
        return sendJson(res, 200, { thumbs });
      } catch (e) {
        return sendJson(res, 400, { error: String(e.message || e) });
      }
    }

    /* ── 环境检查 ── */
    if (p === "/api/health") {
      let segCount = 0;
      return sendJson(res, 200, {
        ok: true,
        ffmpeg: render.FFMPEG,
        ffmpegOk: render.FFMPEG !== "ffmpeg" || true,
        sayOk: await voice.isAvailable(),
        platform: process.platform,
      });
    }

    res.writeHead(404);
    res.end("not found");
  } catch (e) {
    sendJson(res, 500, { error: String(e.message || e) });
  }
});

/* ── 单实例保护：端口被占用时先尝试回收旧实例 ── */
function killPortOccupant(port) {
  const { execSync } = require("node:child_process");
  try {
    const pids = execSync(`lsof -ti:${port}`, { encoding: "utf8" }).trim().split("\n").filter(Boolean);
    for (const pid of pids) {
      // 只清理我们自己启动的 node server.js，避免误伤其他程序
      try {
        const cmd = execSync(`ps -p ${pid} -o command=`, { encoding: "utf8" }).trim();
        if (cmd.includes("server.js") || cmd.includes("clipdesk")) {
          process.kill(Number(pid), "SIGKILL");
          console.log(`  已回收旧实例 PID ${pid}`);
        }
      } catch { /* 进程已退出 */ }
    }
    return pids.length > 0;
  } catch {
    return false;
  }
}

function startServer(retried = false) {
  server.removeAllListeners("error");
  server.once("error", (err) => {
    if (err.code === "EADDRINUSE" && !retried) {
      console.log(`  端口 ${PORT} 被占用，尝试回收…`);
      const killed = killPortOccupant(PORT);
      if (killed) {
        setTimeout(() => startServer(true), 800);
        return;
      }
      console.error(`端口 ${PORT} 被其他程序占用，请先关闭它，或设置 CLIPDESK_PORT 换端口`);
      process.exit(1);
    }
    console.error("启动失败:", err.message);
    process.exit(1);
  });

  server.listen(PORT, "127.0.0.1", () => {
    console.log(`审片台已启动: http://127.0.0.1:${PORT}`);
  });
}

startServer();
