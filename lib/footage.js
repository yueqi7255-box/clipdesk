/**
 * 帧合成引擎
 *
 * 把录屏帧序列 + 字幕 + 顶栏 + 指针效果，合成为每个镜头的画面。
 *
 * 与 ffmpeg 直接拼 filter 不同，这里用纯 Node 合成 PNG 帧序列，
 * 再交给 ffmpeg 编码。原因是顶栏节点图、指针涟漪等效果用 filter 表达很笨重。
 *
 * 依赖：Pillow（通过 python3 合成的降级路径）或纯 JS 方案。
 * 本项目采用「生成 PNG 帧 → ffmpeg 编码」的两段式：
 *   · 好处：叠加逻辑自由度高，容易调整
 *   · 代价：帧多时磁盘占用大，所以按镜头分段、及时清理
 */
const fs = require("node:fs");
const fsp = require("node:fs/promises");
const path = require("node:path");
const { execFile } = require("node:child_process");

const DEFAULT_SIZE = { width: 1600, height: 900 };
const DEFAULT_FPS = 30;

/** 读取录制元数据 */
async function loadRecording(footageDir) {
  const p = path.join(footageDir, "record.json");
  if (!fs.existsSync(p)) return null;
  return JSON.parse(await fsp.readFile(p, "utf8"));
}

/** 根据时间戳找到最接近的帧索引 */
function frameAt(recording, timeSec) {
  const frames = recording.frames || [];
  if (!frames.length) return null;
  const ms = timeSec * 1000;
  let lo = 0, hi = frames.length - 1;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (frames[mid].t < ms) lo = mid + 1;
    else hi = mid;
  }
  const cand = [frames[Math.max(0, lo - 1)], frames[lo]].filter(Boolean);
  return cand.reduce((a, b) => (Math.abs(a.t - ms) <= Math.abs(b.t - ms) ? a : b));
}

/**
 * 计算某个视频时间点对应的素材帧
 * @param {Object} shot    镜头定义
 * @param {Object} rec     录制元数据
 * @param {number} tInShot 镜头内的相对时间（0..duration）
 * @returns {Object|null}  {idx, t}
 */
function resolveFrame(shot, rec, tInShot) {
  const f = shot.footage;
  if (!f || f.start == null || f.end == null) return null;
  const dur = Math.max(0.001, shot.duration || 1);
  const rel = Math.max(0, Math.min(1, tInShot / dur));
  const rt = f.start + rel * (f.end - f.start);
  return frameAt(rec, rt);
}

/** 判断项目是否有可用的录屏素材 */
async function hasFootage(projectDir) {
  const rec = await loadRecording(path.join(projectDir, "footage"));
  if (!rec || !rec.frames?.length) return false;
  const probe = path.join(projectDir, "footage", "frames", "f00000.png");
  return fs.existsSync(probe);
}

/** 生成 ffmpeg 编码参数（统一，保证分段与整片一致） */
function encodeArgs(fps) {
  return ["-c:v", "libx264", "-preset", "veryfast", "-crf", "22",
    "-pix_fmt", "yuv420p", "-r", String(fps)];
}

module.exports = {
  DEFAULT_SIZE,
  DEFAULT_FPS,
  loadRecording,
  frameAt,
  resolveFrame,
  hasFootage,
  encodeArgs,
};
