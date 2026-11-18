---
name: clipdesk
description: 审片台（本地视频审片与返工工具）。当用户提到"审片台""处理意见""按意见改视频""剪辑台""clipdesk"，或要求在评审视频后修改并产出新版本时使用。读取用户在网页上写的意见，判断处理方式，直接执行返工并生成新版本，最后返回网页地址。
---

# 审片台 · 意见返工

把用户在网页上写的审片意见，变成新一版视频。

## 定位工具

安装路径记录在 Skill 目录的 `INSTALL_PATH` 文件里：

```bash
CLIPDESK_ROOT="$(cat ~/.dsh/skills/clipdesk/INSTALL_PATH 2>/dev/null)"
# 若不存在，常见位置：
#   ~/Library/Mobile Documents/iCloud~md~obsidian/Documents/03_Y7工作空间/02_AI场景落地/视频剪辑台
```

后续所有命令都在 `$CLIPDESK_ROOT` 下执行。

## 执行流程

### 第 1 步：启动服务并读取意见

```bash
cd "$CLIPDESK_ROOT"
CLIPDESK_NO_OPEN=1 node bin/clipdesk list
```

拿到工作区列表后，读取目标工作区的项目数据：

```bash
WS_ID="<工作区id>"
curl -s "http://127.0.0.1:4300/api/project?id=$WS_ID"
```

从返回的 JSON 中取出：

- `notes` 里 `status === "open"` 的条目 —— **这是本轮要处理的意见**
- `shots` —— 当前镜头列表（含文稿、时长）
- `currentVersion` —— 当前版本号

每条意见包含：

| 字段 | 含义 |
| --- | --- |
| `time` | 成片时间点（秒） |
| `shotId` | 所属镜头，如 `S14` |
| `text` | 用户原话 |
| `status` | `open` / `resolved` |

### 第 2 步：逐条判断处理方式

对每条意见判断属于哪一类。**不要问用户，直接判断并执行。**

| 判断依据 | 处理方式 | 具体动作 |
| --- | --- | --- |
| 意见只涉及**文案措辞** | 改文稿 | 修改 `shots[i].voice.text` |
| 意见说**某段时间该停久/太快** | 调时长 | 修改 `shots[i].duration` |
| 意见说**画面内容不对、缺演示、顺序错** | 需重录 | 见下方「重录」 |
| 意见提到**切片/段落位置** | 调时间点 | 调整该镜头的 `duration` 或顺序 |
| 判断不了具体指向 | 按最合理理解处理，并在回复中说明假设 | — |

**判断原则**：

- 用户写了「重录」「重新录」「画面不对」→ 一定重录
- 微调文案能解决 → 不重录
- 拿不准时：**优先按最小改动处理**，改完在回复里说明「如果理解有偏，告诉我」

### 第 3 步：执行修改

修改项目 JSON 后保存：

```bash
curl -s -X POST "http://127.0.0.1:4300/api/project" \
  -H 'content-type: application/json' \
  -d "{\"id\":\"$WS_ID\",\"data\":<完整项目JSON>}"
```

**注意**：必须提交完整 project 对象，不能只提交变动的字段。

### 第 4 步：重新合成

```bash
# 1. 生成配音（按镜头缓存，只重生成改动的）
curl -s -X POST http://127.0.0.1:4300/api/render/voice \
  -H 'content-type: application/json' -d "{\"id\":\"$WS_ID\"}"
# 返回 {"jobId":"voice-xxx"}，轮询 /api/job?id=<jobId> 直到 status=done

# 2. 渲染分段（改动的镜头重渲，其余复用缓存）
curl -s -X POST http://127.0.0.1:4300/api/render/segments \
  -H 'content-type: application/json' -d "{\"id\":\"$WS_ID\"}"

# 3. 拼接成整片，生成新版本
curl -s -X POST http://127.0.0.1:4300/api/render/concat \
  -H 'content-type: application/json' -d "{\"id\":\"$WS_ID\"}"
```

轮询任务：

```bash
curl -s "http://127.0.0.1:4300/api/job?id=<jobId>"
# status: running / done / error
```

### 第 5 步：标记意见已解决

返工成功后，把本轮处理的意见 `status` 改为 `resolved`，写回项目。

### 第 6 步：返回结果

回复用户时包含：

1. **改了哪些镜头**，以及每条意见是怎么处理的
2. **新版本号**（如 v10）
3. **网页地址**：`http://127.0.0.1:4300/`

格式示例：

```
处理了 2 条意见：

· S14（00:59）「切页动作被压缩了」
  → 重新录制该镜头，切页后停留时间加长到 7 秒

· S10（00:42）「身高视图切得太快」
  → 镜头时长 4.1s → 6.0s

已生成 v10，可查看：http://127.0.0.1:4300/
```

## 重录怎么做

审片台本身**不能**重录操作画面（需要驱动浏览器点击真实系统）。重录要在被剪辑项目自己的环境里完成，然后把新素材接入。

如果项目有录制脚本（如 ego-browser 脚本）：

1. 在被剪辑项目目录执行录制脚本，产出新帧序列
2. 更新项目 JSON 里对应镜头的 `footage` 字段
3. 重新走第 4 步合成

如果只是**延长某个镜头的停留时间**（不改画面内容），不需要重录，直接改 `duration` 即可。

## 关键约束

1. **不要先出计划等确认** —— 用户已明确要求直接改。只有完全无法判断时才说明假设。
2. **返回网页地址** —— 每次完成都要给，用户不需要自己启动。
3. **端口**：默认 4300。如果被占用，服务会启动失败，先检查 `lsof -ti:4300`。
4. **服务保持运行** —— 不要在处理完就关掉，用户要接着在网页上看。

## 环境检查

执行前先确认：

```bash
curl -s http://127.0.0.1:4300/api/health
```

应返回 `{"ok":true,"ffmpeg":"...","sayOk":true,...}`。

若服务未启动：

```bash
cd "$CLIPDESK_ROOT"
CLIPDESK_NO_OPEN=1 node bin/clipdesk
```
