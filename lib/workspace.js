/**
 * 工作区管理
 *
 * 设计要点：
 *  · 工作区 = 一个视频项目，按「项目名」呈现，不暴露文件夹路径给用户看
 *  · 工具自身数据（注册表）与被剪辑项目的数据分离
 *  · 被剪辑项目的数据统一放在该项目下的 .video-workspace/ 目录
 */
const fs = require("node:fs");
const fsp = require("node:fs/promises");
const path = require("node:path");

const ROOT = path.resolve(__dirname, "..");
const REGISTRY = path.join(ROOT, "workspaces.json");
const WS_DIR_NAME = ".video-workspace";

/** 视频项目统一存放位置 */
const path0 = require("node:path");
const os0 = require("node:os");

/**
 * 视频项目根目录，优先级：
 *   1. 环境变量 CLIPDESK_VIDEO_ROOT（临时覆盖）
 *   2. 配置文件 ~/.clipdesk.json 的 videoRoot（安装时确认）
 *   3. 默认 ~/Videos/clipdesk
 */
function resolveVideoRoot() {
  if (process.env.CLIPDESK_VIDEO_ROOT) return process.env.CLIPDESK_VIDEO_ROOT;
  // 用 HOME 环境变量，便于安装脚本指定到自定义位置
  const home = process.env.HOME || os0.homedir();
  try {
    const conf = JSON.parse(require("node:fs").readFileSync(
      path0.join(home, ".clipdesk.json"), "utf8"));
    if (conf.videoRoot) return conf.videoRoot;
  } catch { /* 无配置文件，用默认 */ }
  return path0.join(home, "Videos", "clipdesk");
}

const VIDEO_ROOT = resolveVideoRoot();

/** 是否为合规的项目根目录 */
function isUnderVideoRoot(p) {
  try {
    const abs = path.resolve(p);
    return abs.startsWith(path.resolve(VIDEO_ROOT));
  } catch {
    return false;
  }
}

/** 读取注册表 */
async function readRegistry() {
  try {
    const raw = await fsp.readFile(REGISTRY, "utf8");
    return JSON.parse(raw);
  } catch {
    return { workspaces: [] };
  }
}

/** 写入注册表 */
async function writeRegistry(data) {
  await fsp.writeFile(REGISTRY, JSON.stringify(data, null, 2), "utf8");
}

/** 生成简短 id */
function shortId() {
  return Math.random().toString(36).slice(2, 10);
}

/** 列出所有工作区（含实时统计） */
async function listWorkspaces() {
  const reg = await readRegistry();
  const out = [];
  for (const ws of reg.workspaces) {
    const projPath = projectFile(ws.path);
    let project = null;
    try {
      project = JSON.parse(await fsp.readFile(projPath, "utf8"));
    } catch { /* 项目文件缺失时仍列出，标记为异常 */ }

    const notes = project?.notes || [];
    out.push({
      id: ws.id,
      name: ws.name,
      path: ws.path,
      createdAt: ws.createdAt,
      updatedAt: project?.updatedAt || ws.updatedAt,
      currentVersion: project?.currentVersion || 0,
      openNotes: notes.filter((n) => n.status === "open").length,
      totalNotes: notes.length,
      shotCount: project?.shots?.length || 0,
      ok: !!project,
    });
  }
  return out.sort((a, b) => (b.updatedAt || "").localeCompare(a.updatedAt || ""));
}

/** 解析项目文件位置：优先子目录，兼容直接放在根目录 */
function projectFile(wsPath) {
  const nested = path.join(wsPath, WS_DIR_NAME, "project.json");
  if (fs.existsSync(nested)) return nested;
  const flat = path.join(wsPath, "project.json");
  if (fs.existsSync(flat)) return flat;
  return nested;   // 默认按子目录返回（新建时用）
}

/** 获取单个工作区的项目数据 */
async function getProject(wsId) {
  const reg = await readRegistry();
  const ws = reg.workspaces.find((w) => w.id === wsId);
  if (!ws) throw new Error("工作区不存在: " + wsId);
  const project = JSON.parse(await fsp.readFile(projectFile(ws.path), "utf8"));
  project._wsPath = ws.path;
  return project;
}

/** 保存项目数据 */
async function saveProject(wsId, project) {
  const reg = await readRegistry();
  const ws = reg.workspaces.find((w) => w.id === wsId);
  if (!ws) throw new Error("工作区不存在: " + wsId);
  project.updatedAt = new Date().toISOString();
  const clean = { ...project };
  delete clean._wsPath;
  const target = projectFile(ws.path);
  await fsp.mkdir(path.dirname(target), { recursive: true });
  await fsp.writeFile(target, JSON.stringify(clean, null, 2), "utf8");
  ws.updatedAt = project.updatedAt;
  await writeRegistry(reg);
  return project;
}

/** 新建工作区：指定项目文件夹，生成 .video-workspace 结构 */
async function createWorkspace({ name, projectPath }) {
  // 未指定路径时，放到统一项目根目录下
  if (!projectPath) {
    projectPath = path.join(VIDEO_ROOT, name || `未命名-${shortId()}`);
  }
  const abs = path.resolve(projectPath);
  if (!fs.existsSync(abs)) {
    await fsp.mkdir(abs, { recursive: true });
  }
  const dir = path.join(abs, WS_DIR_NAME);
  const projFile = path.join(dir, "project.json");
  if (fs.existsSync(projFile)) {
    throw new Error("该文件夹已存在视频工作区");
  }

  for (const sub of ["footage/frames", "voice", "segments", "thumbs", "versions"]) {
    await fsp.mkdir(path.join(dir, sub), { recursive: true });
  }

  const project = {
    id: shortId(),
    name: name || path.basename(abs),
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    shots: [],
    notes: [],
    currentVersion: 0,
    versions: [],
    config: {
      videoFile: "",
      totalDuration: 0,
      voiceName: "Lilian (Premium)",
      voiceRate: 180,
      size: { width: 1600, height: 900 },
      fps: 30,
      stages: [],
      brand: { title: name || path.basename(abs), sub: "" },
    },
  };
  await fsp.writeFile(projFile, JSON.stringify(project, null, 2), "utf8");

  const reg = await readRegistry();
  const ws = {
    id: project.id,
    name: project.name,
    path: abs,
    createdAt: new Date().toISOString(),
    updatedAt: project.updatedAt,
  };
  reg.workspaces.push(ws);
  await writeRegistry(reg);

  return { workspace: ws, project };
}

/** 删除工作区登记（不删项目文件） */
async function removeWorkspace(wsId) {
  const reg = await readRegistry();
  const before = reg.workspaces.length;
  reg.workspaces = reg.workspaces.filter((w) => w.id !== wsId);
  await writeRegistry(reg);
  return reg.workspaces.length < before;
}

/** 解析工作区内的文件绝对路径（用于提供静态资源） */
async function resolveFile(wsId, relPath) {
  const reg = await readRegistry();
  const ws = reg.workspaces.find((w) => w.id === wsId);
  if (!ws) throw new Error("工作区不存在");
  // 子目录存在则用它，否则用项目根（兼容直接放在根目录的项目）
  const nested = path.join(ws.path, WS_DIR_NAME);
  const base = fs.existsSync(nested) ? nested : ws.path;
  const full = path.resolve(base, relPath);
  if (!full.startsWith(base)) throw new Error("非法路径");
  return full;
}

module.exports = {
  VIDEO_ROOT,
  isUnderVideoRoot,
  listWorkspaces,
  getProject,
  saveProject,
  createWorkspace,
  removeWorkspace,
  resolveFile,
  readRegistry,
  WS_DIR_NAME,
};
