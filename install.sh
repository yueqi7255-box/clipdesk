#!/usr/bin/env bash
# 审片台 · 一键安装
#
# 用法：bash install.sh
#
# 做的事：
#   1. 检查 Node.js（必须 >= 18）
#   2. 准备 ffmpeg（优先用项目内置，其次系统，最后按需下载）
#   3. 检查 macOS say（配音用）
#   4. 注册 clipdesk 命令
#   5. 安装 Skill 到 ~/.dsh/skills/（clipdesk + demo-video）
#   6. 自检

set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
SKILL_SRC="$ROOT/skill/clipdesk"
DEMO_SKILL_SRC="$ROOT/skill/demo-video"
SKILL_DST="${DSH_SKILLS_DIR:-$HOME/.dsh/skills}"
BIN_DST="${CLIPDESK_BIN_DIR:-$HOME/.local/bin}"

green() { printf "\033[32m%s\033[0m\n" "$1"; }
yellow() { printf "\033[33m%s\033[0m\n" "$1"; }
red() { printf "\033[31m%s\033[0m\n" "$1"; }

echo "════════════════════════════════════"
echo "  审片台 · 安装"
echo "════════════════════════════════════"
echo ""

# ── 1. Node.js ──
if ! command -v node >/dev/null 2>&1; then
  red "✗ 未找到 Node.js，请先安装：https://nodejs.org"
  exit 1
fi
NODE_MAJOR=$(node -p "process.versions.node.split('.')[0]")
if [ "$NODE_MAJOR" -lt 18 ]; then
  red "✗ Node.js 版本过低（当前 $(node -v)），需要 >= 18"
  exit 1
fi
green "✓ Node.js $(node -v)"

# ── 2. ffmpeg ──
FF_OK=0
if [ -x "$ROOT/bin/ffmpeg" ]; then
  green "✓ ffmpeg（项目内置）"
  FF_OK=1
elif command -v ffmpeg >/dev/null 2>&1; then
  green "✓ ffmpeg（系统）$(ffmpeg -version 2>/dev/null | head -1 | cut -d' ' -f3)"
  FF_OK=1
fi

if [ "$FF_OK" -eq 0 ]; then
  yellow "… 未找到 ffmpeg，尝试下载静态版本"
  mkdir -p "$ROOT/bin"
  ARCH=$(uname -m)
  if [ "$ARCH" = "arm64" ]; then
    PKG="@ffmpeg-installer/darwin-arm64"
  else
    PKG="@ffmpeg-installer/darwin-x64"
  fi
  TMPD=$(mktemp -d)
  if (cd "$TMPD" && npm install "$PKG" --no-audit --no-fund --silent >/dev/null 2>&1); then
    cp "$TMPD/node_modules/$PKG/ffmpeg" "$ROOT/bin/ffmpeg"
    chmod +x "$ROOT/bin/ffmpeg"
    rm -rf "$TMPD"
    green "✓ ffmpeg 已下载到 bin/ffmpeg"
  else
    rm -rf "$TMPD"
    red "✗ ffmpeg 下载失败"
    echo "  请手动安装：brew install ffmpeg"
    echo "  或把 ffmpeg 可执行文件放到：$ROOT/bin/ffmpeg"
    exit 1
  fi
fi

# ── 3. say（配音）──
if [ "$(uname)" = "Darwin" ]; then
  if command -v say >/dev/null 2>&1; then
    VOICE=$(say -v '?' 2>/dev/null | grep -c "Lilian (Premium)" || true)
    if [ "$VOICE" -gt 0 ]; then
      green "✓ say（黎潋 Premium 音色可用）"
    else
      green "✓ say"
      yellow "  提示：未检测到「黎潋」高级音色，可在「系统设置 → 辅助功能 → 朗读内容」中下载"
    fi
  else
    yellow "… 未找到 say，配音功能不可用"
  fi
else
  yellow "… 非 macOS，配音功能不可用（其他功能正常）"
fi

# ── 3.5 Pillow（逐帧合成必需）──
if python3 -c "import PIL" 2>/dev/null; then
  PILLOW_VER=$(python3 -c "import PIL; print(PIL.__version__)" 2>/dev/null)
  green "✓ Pillow $PILLOW_VER"
else
  red "✗ 缺少 Pillow（逐帧合成必需）"
  echo "  请执行：pip3 install Pillow"
  exit 1
fi

# ── 4. 注册命令 ──
mkdir -p "$BIN_DST"
ln -sf "$ROOT/bin/clipdesk" "$BIN_DST/clipdesk"
chmod +x "$ROOT/bin/clipdesk"
green "✓ 命令已注册：$BIN_DST/clipdesk"

case ":$PATH:" in
  *":$BIN_DST:"*) ;;
  *) yellow "  提示：$BIN_DST 不在 PATH 中，可执行一次："
     echo "    echo 'export PATH=\"\$PATH:$BIN_DST\"' >> ~/.zshrc && source ~/.zshrc" ;;
esac

# ── 5. 安装 Skill ──
if [ -d "$SKILL_SRC" ]; then
  mkdir -p "$SKILL_DST"
  # clipdesk：渲染与返工
  rm -rf "$SKILL_DST/clipdesk"
  cp -R "$SKILL_SRC" "$SKILL_DST/clipdesk"
  # 把实际安装路径写进 Skill，供 Agent 定位
  echo "$ROOT" > "$SKILL_DST/clipdesk/INSTALL_PATH"
  green "✓ Skill 已安装：$SKILL_DST/clipdesk"

  # demo-video：录屏与切片（配套 Skill）
  if [ -d "$DEMO_SKILL_SRC" ]; then
    rm -rf "$SKILL_DST/demo-video"
    cp -R "$DEMO_SKILL_SRC" "$SKILL_DST/demo-video"
    echo "$ROOT" > "$SKILL_DST/demo-video/INSTALL_PATH"
    green "✓ Skill 已安装：$SKILL_DST/demo-video"
  else
    yellow "… 未找到 demo-video skill，跳过"
  fi
else
  yellow "… 未找到 skill 目录，跳过"
fi

# ── 6. 自检 ──
echo ""
echo "── 自检 ──"
cd "$ROOT"
CLIPDESK_NO_OPEN=1 node bin/clipdesk status || true

echo ""
green "安装完成"
echo ""
echo "已装 Skill："
echo "  clipdesk      渲染、审片、返工、出成片"
echo "  demo-video    录屏、切片、接入 clipdesk"
echo ""
echo "下一步："
echo "  clipdesk              启动审片台并打开浏览器"
echo "  clipdesk list         查看所有工作区"
echo "  clipdesk new 名称 路径  新建工作区"
