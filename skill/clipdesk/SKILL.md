---
name: clipdesk
description: 审片台（本地视频审片与返工工具）。当用户提到"审片台""处理意见""按意见改视频""剪视频""渲染视频""clipdesk"，或要求在评审视频后修改并产出新版本时使用。支持建项目、写镜头、渲染、读审片意见并按意见返工出新版本。
---

# 审片台 ClipDesk

本地视频制作与返工工具。核心能力：**分段渲染 + 指纹缓存**，改一个镜头只重渲那一个。

## 定位工具

安装脚本会把实际路径写进 Skill 目录的 `INSTALL_PATH` 文件：

```bash
CLIPDESK_ROOT="$(cat ~/.dsh/skills/clipdesk/INSTALL_PATH 2>/dev/null)"

# 若为空，依次尝试常见位置
if [ -z "$CLIPDESK_ROOT" ] || [ ! -f "$CLIPDESK_ROOT/bin/clipdesk" ]; then
  for p in ~/clipdesk ~/.clipdesk/clipdesk; do
    [ -f "$p/bin/clipdesk" ] && CLIPDESK_ROOT="$p" && break
  done
fi
```

若都找不到，问用户 ClipDesk 装在哪。

**所有命令都在 `$CLIPDESK_ROOT` 下执行。**

## 环境自检

```bash
cd "$CLIPDESK_ROOT" && node bin/clipdesk status
```

期望输出包含 `ffmpeg` 路径、`say 可用`、`Pillow` 版本。缺 Pillow：

```bash
pip3 install Pillow
```

## 核心概念

| 概念 | 说明 |
| --- | --- |
| 工作区 | 一个视频项目 = 一个文件夹，注册在 `workspaces.json` |
| 镜头 shot | 最小单元，有编号（S01…）、文稿、时长、素材区间 |
| 指纹缓存 | 镜头内容变了才重渲，其余复用 `segments/*.mp4` |
| 模板 template | 控制外壳（顶栏/字幕/节点图），改 JSON 就能调样式 |
| 预览 preview | 只重渲改动镜头，不生成成片，用于快速看效果 |
| 出成片 export | 拼接所有镜头 + 音轨，输出 `versions/vN/项目名-vN.mp4` |

## 项目目录结构

```
<项目>/
├── project.json      镜头、文稿、意见、版本（核心）
├── footage/
│   ├── record.json   帧时间戳与点击坐标
│   └── frames/       f00000.png, f00001.png …
├── voice/            配音（自动生成）
├── segments/         分段渲染缓存（自动生成）
├── thumbs/           缩略图（自动生成）
└── versions/v1/video.mp4
```

## 命令速查

```bash
cd "$CLIPDESK_ROOT"

node bin/clipdesk list                    # 列出所有项目
node bin/clipdesk status                  # 环境检查
node bin/clipdesk new "项目名" [路径]       # 新建项目
node bin/clipdesk render <项目>            # 渲染预览（不出成片）
node bin/clipdesk render <项目> --no-voice # 预览，复用已有配音
node bin/clipdesk export <项目>            # 导出成片到 versions/
node bin/clipdesk thumbs <项目>            # 生成缩略图
```

项目参数支持 id、全名或名称片段。

**渲染不需要 Web 服务**，CLI 直接执行。

---

# 任务一：按意见返工

## 第 1 步：读取意见

```bash
cd "$CLIPDESK_ROOT"
node bin/clipdesk list
```

拿到项目后直接读文件（比走 API 更可靠）：

```bash
cat "<项目路径>/project.json"
```

从 JSON 中取出 `notes` 里 `status === "open"` 的条目 —— **这是本轮要处理的意见**。

每条意见：

| 字段 | 含义 |
| --- | --- |
| `time` | 成片时间点（秒） |
| `shotId` | 所属镜头，如 `S14` |
| `text` | 用户原话 |
| `scope` | `second` / `shot` / `all` |
| `status` | `open` / `resolved` |

## 第 2 步：逐条判断处理方式

**不要问用户，直接判断并执行。**

| 判断依据 | 处理 | 具体动作 |
| --- | --- | --- |
| 只涉及文案措辞 | 改文稿 | 修改 `shots[i].voice.text` |
| 说某段该停久/太快 | 调时长 | 修改 `shots[i].duration` |
| 说画面内容不对、缺演示、顺序错 | 需重录 | 见下方「重录」 |
| 提到切片/段落位置 | 调时间点 | 调整 `duration` 或 `footage` 区间 |
| 判断不了指向 | 按最合理理解处理，回复中说明假设 | — |

**原则**：

- 用户说「重录」「重新录」「画面不对」→ 一定重录
- 微调文案能解决 → 不重录
- 拿不准时按**最小改动**处理，回复里说明「如果理解有偏，告诉我」

## 第 3 步：执行修改

直接编辑 `project.json`，或用脚本改。**必须保持 JSON 结构完整**，不能只写变动的字段。

改完校验：

```bash
python3 -c "import json; json.load(open('<项目路径>/project.json')); print('JSON 合法')"
```

## 第 4 步：渲染预览

```bash
cd "$CLIPDESK_ROOT"
node bin/clipdesk render <项目>
```

输出：

```
✓ 预览已更新
  时长 105.3s · 耗时 7.2s
  分段：新渲 1 / 复用 23（共 24）
  未生成成片。审片满意后执行 clipdesk export 出片
```

`新渲 1 / 复用 23` 说明缓存生效，只重渲了改动的镜头。

**这一步不生成成片**，用户接着在浏览器看效果。

## 第 5 步：标记意见已解决

把本轮处理的意见 `status` 改为 `resolved`，写回 `project.json`。

## 出成片（用户明确要求时）

**只有用户说「出成片」「导出」「生成成片」「可以交付了」时才执行这一步。**

```bash
node bin/clipdesk export <项目>
```

输出：

```
✓ 成片已导出
  版本 v6 · 时长 102.4s
  文件 versions/v6/项目名-v6.mp4
  可直接发送：项目名-v6.mp4
```

产物是 `versions/vN/<项目名>-vN.mp4`，含视频与音轨，可直接发人。

**不要自动出片。** 日常改片只做预览，出片是用户满意后的独立动作。

## 第 6 步：启动服务并回复

```bash
cd "$CLIPDESK_ROOT"
CLIPDESK_NO_OPEN=1 node bin/clipdesk web
```

回复用户时包含：

1. **改了哪些镜头**，每条意见怎么处理的
2. **新版本号**
3. **网页地址** `http://127.0.0.1:4300`

格式：

```
处理了 2 条意见：

· S14（00:59）「切页动作被压缩了」
  → 延长该镜头停留时间 5.2s → 7.0s

· S10（00:42）「身高视图切得太快」
  → 镜头时长 4.1s → 6.0s

已生成 v10，可查看：http://127.0.0.1:4300/
```

## 重录怎么做

审片台**不能**自己录操作画面。重录要在被剪辑项目自己的环境里完成。

如果项目有录制脚本：

1. 执行录制脚本产出新帧序列
2. 更新 `project.json` 里对应镜头的 `footage.start/end`
3. 重新渲染

**如果只是延长停留时间**（不改画面内容），不需要重录，直接改 `duration`。

---

# 任务二：建项目并出第一版

## 建项目

```bash
cd "$CLIPDESK_ROOT"
node bin/clipdesk new "项目名"
```

会在 `CLIPDESK_VIDEO_ROOT`（默认 `~/Videos/clipdesk`）下创建目录结构。

## 无素材也能跑

只写文稿不接录屏，会生成纯色文字卡。适合先验证流程。

编辑 `project.json` 的 `shots`：

```json
{
  "shots": [
    {
      "id": "S01",
      "voice": { "text": "这是第一句话。", "duration": 3.0 },
      "duration": 3.0
    }
  ],
  "config": {
    "template": "classic",
    "size": { "width": 1920, "height": 1080 },
    "fps": 30,
    "brand": { "title": "视频标题", "sub": "副标题" }
  }
}
```

然后渲染：

```bash
node bin/clipdesk render "项目名"
```

## 接录屏素材

1. 帧序列放进 `footage/frames/`，命名 `f00000.png`、`f00001.png`…
2. 写 `footage/record.json`：

```json
{
  "frames": [{ "idx": 0, "t": 0 }, { "idx": 1, "t": 87 }],
  "clicks": [{ "t": 4141, "x": 866, "y": 273 }],
  "duration": 142600
}
```

- `frames[].t`：帧相对录制开始的毫秒数
- `clicks[].t`：点击事件毫秒数

3. 每个镜头加 `footage` 区间：

```json
"footage": { "start": 0.5, "end": 4.0 }
```

---

# 任务三：换模板

改 `project.json`：

```json
"config": { "template": "minimal" }
```

内置：`classic`（默认）、`minimal`（无顶栏）、`bold`（高对比）。

模板定义在 `$CLIPDESK_ROOT/templates/*.json`，包含画布、颜色、字号、边距。

**做新模板**：复制一份 `classic.json` 改参数即可，不用动代码。

改完重新渲染生效（模板名参与指纹，会自动重渲）。

---

# 关键约束

1. **不要先出计划等确认** —— 用户已明确要求直接改。只有完全无法判断时才说明假设。
2. **每次完成都要给网页地址** —— 用户不需要自己启动。
3. **端口默认 4300**，被占用时用 `CLIPDESK_PORT=4400`。
4. **服务保持运行**，不要处理完就关，用户要接着看片。
5. **项目放本地磁盘** —— iCloud/网盘目录读帧慢几十倍。
6. **改 JSON 后一定要校验合法性**，损坏会导致整个项目打不开。
