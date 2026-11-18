# 审片台 ClipDesk

> 本地视频审片与返工工具。在浏览器里边看片边写意见，AI 按意见改片，只重渲改动过的镜头。

做视频最烦的不是做第一版，是改第十版。每次改一句话，都要重录、重配音、重新合成整片，一小时就没了。

审片台把这件事拆开了：**看片写意见 → 局部重渲 → 出新版本**。改一个镜头只渲那一个，其余复用缓存。

![审片台界面](docs/screenshot.jpg)

---

## 它解决什么

| 传统流程 | 审片台 |
| --- | --- |
| 改一句话，重跑整个脚本 | 只重渲受影响的镜头（其余走缓存） |
| 意见散在微信/文档里，对不上时间点 | 意见直接钉在视频时间点上，自动关联镜头 |
| 改完不确定改对没 | 版本历史可对比，随时切回上一版 |
| 想换个视觉风格要改代码 | 换模板只改一个字符串 |

---

## 环境要求

- **macOS**（配音用系统 `say`，窗口用 `open`，其他平台部分功能不可用）
- **Node.js ≥ 18**
- **Python 3 + Pillow**：`pip3 install Pillow`

ffmpeg 不用手动装，`install.sh` 会自动下载到 `bin/ffmpeg`。

---

## 安装

```bash
git clone https://github.com/<你的用户名>/clipdesk.git
cd clipdesk
bash install.sh
```

安装脚本会做这些事：

1. 检查 Node.js 版本
2. 准备 `ffmpeg`（内置优先，其次系统，最后自动下载）
3. 检查 macOS `say` 与中文音色
4. 把 `clipdesk` 命令注册到 `~/.local/bin`
5. 安装配套 Skill 到 `~/.dsh/skills/clipdesk`
6. 跑一遍自检

装完确认一下：

```bash
clipdesk status
```

```
环境检查：
  Node    v22.19.0
  ffmpeg  /path/to/clipdesk/bin/ffmpeg
  say     可用
  Pillow  12.3.0
  平台    darwin
  视频根  /Users/you/Videos/clipdesk
  服务    未启动 http://127.0.0.1:4300
```

---

## 启动

```bash
clipdesk
```

会自动启动本地服务并打开浏览器 `http://127.0.0.1:4300`。

端口被占用时：

```bash
CLIPDESK_PORT=4400 clipdesk
```

---

## 用法

### 1. 新建项目

点右上角文件夹图标，选一个本地目录。程序会在该目录下创建：

```
你的项目/
├── project.json      ← 镜头、文稿、意见、版本
├── footage/
│   ├── record.json   ← 录屏的帧时间戳与点击坐标
│   └── frames/       ← 帧序列 f00000.png, f00001.png …
├── voice/            ← 配音（自动生成）
├── segments/         ← 分段渲染缓存（自动生成）
├── thumbs/           ← 镜头缩略图（自动生成）
└── versions/         ← 历史版本
    └── v1/video.mp4
```

**没有素材也能跑**：只写文稿不接录屏，会生成纯色文字卡版本，适合先验证流程。

### 2. 准备素材

如果你已经录了屏，把帧序列放进 `footage/frames/`，并在 `footage/record.json` 写清楚时间戳：

```json
{
  "frames": [
    { "idx": 0, "t": 0 },
    { "idx": 1, "t": 87 }
  ],
  "clicks": [
    { "t": 4141, "x": 866, "y": 273 }
  ],
  "duration": 142600
}
```

- `frames[].t`：该帧相对录制开始的毫秒数
- `clicks[].t`：点击事件相对录制开始的毫秒数
- 帧文件命名：`f` + 5 位序号 + `.png`，如 `f00007.png`

### 3. 写镜头

编辑 `project.json` 的 `shots` 数组：

```json
{
  "id": "S01",
  "voice": {
    "text": "班级排座系统，让排座位从半天变成几分钟。",
    "duration": 3.5
  },
  "duration": 3.5,
  "footage": { "start": 0.5, "end": 4.0 }
}
```

| 字段 | 说明 |
| --- | --- |
| `voice.text` | 该镜头的解说词 |
| `voice.duration` | 配音时长（TTS 会自动写回） |
| `duration` | 该镜头在成片中的时长 |
| `footage.start` | 素材起点（录制时间轴上的秒数） |
| `footage.end` | 素材终点 |

**取帧规则**：给定视频时间 → 换算成录制时间 → 找最接近的那一帧。

### 4. 渲染

```bash
clipdesk render <项目名>
```

```
渲染：班级排座系统 功能说明视频  (seating-video)

  配音   ████████████████████████ 100%  S24 生成 3.8s
  分段   ████████████████████████ 100%  S24 渲染 · 新渲 1 / 复用 23
  音轨   ████████████████████████ 100%  构建音轨…
  拼接   ████████████████████████ 100%  拼接整片…
  完成   ████████████████████████ 100%  完成 · v3

✓ 渲染完成
  版本 v3 · 时长 102.4s · 耗时 18.5s
  分段：新渲 1 / 复用 23（共 24）
```

**关键：只重渲改过的镜头。** 每段渲染结果按内容指纹缓存，改一句文稿只影响那一个镜头。

不重新配音（复用已有音频）：

```bash
clipdesk render <项目名> --no-voice
```

### 5. 审片写意见

打开 `http://127.0.0.1:4300`，进入项目：

- **左侧**：分镜列表（带缩略图）／文稿／意见，三个页签
- **右侧**：播放器 + 时间轴 + 意见输入框
- **点时间轴上的分镜块**：跳到该镜头并播放
- **拖动时间轴**：任意定位
- **写意见**：暂停在要改的地方，输入内容，选择范围（这一秒／这一段／全片）

意见会自动记录时间点和所属镜头，写入 `project.json`。

### 6. 让 AI 改片

在 DSH / Claude 等支持 Skill 的环境里说：

> 处理意见

AI 会读取意见、判断每条怎么改、执行修改、重新渲染，最后给你新版本和地址。

---

## 外壳模板

视频的顶栏、字幕、节点图由模板控制。切换只改 `project.json`：

```json
"config": { "template": "classic" }
```

内置三套：

| 模板 | 效果 |
| --- | --- |
| `classic` | 深色顶栏 + 四阶段节点图，148px 顶栏，字幕 29px |
| `minimal` | 无顶栏，画面占满，字幕 34px |
| `bold` | 高对比，176px 顶栏，大号节点，字幕 33px |

模板文件在 `templates/*.json`，参数包括画布尺寸、颜色、字号、边距、圆角。**改 JSON 就能调样式，不用动代码。**

也能在审片台页头的下拉里直接切换。

---

## 命令行参考

| 命令 | 说明 |
| --- | --- |
| `clipdesk` | 启动服务并打开浏览器 |
| `clipdesk web` | 只启动服务 |
| `clipdesk render <项目> [--no-voice]` | 渲染成片 |
| `clipdesk thumbs <项目>` | 生成缩略图 |
| `clipdesk list` | 列出所有项目 |
| `clipdesk new <名称> [路径]` | 新建项目 |
| `clipdesk status` | 环境检查 |

项目参数支持 id、全名或名称片段。

---

## 配置

| 环境变量 | 默认值 | 说明 |
| --- | --- | --- |
| `CLIPDESK_VIDEO_ROOT` | `~/Videos/clipdesk` | 项目根目录 |
| `CLIPDESK_PORT` | `4300` | 服务端口 |
| `CLIPDESK_FONT` | 自动探测 | 中文字体路径 |
| `FFMPEG_PATH` | 自动探测 | ffmpeg 路径 |

> **建议把项目放在本地磁盘。** 放在 iCloud / 网盘同步目录里，读帧会慢几十倍（实测单帧读取从 58ms 变成 3 秒）。

---

## 技术实现

```
录屏帧序列 ──┐
文稿 ────────┼─→ Python 逐帧合成 ─→ PNG 序列 ─→ ffmpeg 编码 ─→ 分段 mp4
模板 ────────┘                                    │
                                                  ↓
                                          按顺序拼接 ─→ 整片
                                                  ↑
配音 ──→ 每段补齐到镜头时长 ──→ 完整音轨 ──────────┘
```

**为什么用 Python 合成而不是 ffmpeg filter**：顶栏节点图、指针涟漪这类效果用 filter 表达很笨重，逐帧绘制更自由。

**为什么音轨要补齐**：配音时长和镜头时长可能不一致，直接拼接会音画错位。每段音频先补齐裁到精确时长，再接起来。

**缓存策略**：镜头内容 + 文稿 + 时长 + 模板 + 画布尺寸 → SHA 指纹。指纹没变直接复用。

---

## 目录结构

```
clipdesk/
├── bin/clipdesk          CLI 入口
├── server.js             本地 HTTP 服务
├── lib/
│   ├── workspace.js      项目注册与读写
│   ├── pipeline.js       渲染流水线
│   ├── render.js         分段渲染与拼接
│   ├── composite.py      逐帧合成（外壳绘制）
│   ├── footage.js        素材帧索引
│   └── voice.js          TTS 配音
├── public/index.html     审片台前端
├── templates/            外壳模板
├── skill/clipdesk/       AI Skill
└── install.sh            一键安装
```

---

## 已知限制

- 只支持 macOS（依赖 `say` / `open` / `osascript`）
- 不能自己录制操作画面，需要外部录屏工具产出帧序列
- 配音依赖 macOS 中文音色，其他语言需调整
- 单机工具，没有多用户协作

---

## License

MIT
