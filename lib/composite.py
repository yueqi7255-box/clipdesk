#!/usr/bin/env python3
"""
帧合成器 · 把录屏帧 + 顶栏 + 指针 + 字幕 合成为成片帧序列

用法（由 lib/render.js 调用）：
  python3 composite.py --job /path/to/job.json

job.json:
{
  "projectDir": "...",
  "shot": { "id":"S01", "duration":3.5, "footage":{"start":0.5,"end":4.0},
            "voice":{"text":"..."}, "overlay":{"chapter":"开场"} },
  "recording": { "frames":[{idx,t}], "clicks":[{t,x,y}] },
  "outDir": "...",
  "size": {"width":1600,"height":900},
  "fps": 30,
  "stages": [{"name":"初始排位","ids":["S02","S03"]}, ...],
  "shots": [{id, ...}],          # 全部镜头（用于阶段判断）
  "brand": {"title":"班级排座系统","sub":"功能说明 · 8年级3班"}
}
"""
import argparse
import json
import os
import sys
import tempfile
from PIL import Image, ImageDraw, ImageFont

FONT_CANDIDATES = [
    "/System/Library/Fonts/Hiragino Sans GB.ttc",
    "/System/Library/Fonts/STHeiti Medium.ttc",
    "/System/Library/Fonts/PingFang.ttc",
]
MONO_CANDIDATES = [
    "/System/Library/Fonts/Menlo.ttc",
    "/System/Library/Fonts/Supplemental/Courier New.ttf",
]


TEMPLATE_DIR = os.path.join(os.path.dirname(os.path.abspath(__file__)), "..", "templates")
_DEFAULT_TPL = None


def load_template(name=None):
    """加载外壳模板；未指定或找不到时用 classic"""
    global _DEFAULT_TPL
    if _DEFAULT_TPL is None:
        with open(os.path.join(TEMPLATE_DIR, "classic.json"), encoding="utf-8") as fh:
            _DEFAULT_TPL = json.load(fh)

    if not name:
        return _DEFAULT_TPL

    p = os.path.join(TEMPLATE_DIR, f"{name}.json")
    if not os.path.exists(p):
        return _DEFAULT_TPL
    with open(p, encoding="utf-8") as fh:
        return json.load(fh)


def pick_font(cands, size, index=0):
    for p in cands:
        if os.path.exists(p):
            try:
                return ImageFont.truetype(p, size, index=index)
            except Exception:
                continue
    return ImageFont.load_default()


def ease(t):
    return 2 * t * t if t < 0.5 else 1 - pow(-2 * t + 2, 2) / 2


def find_frame(frames, ms):
    """二分找最接近的帧"""
    lo, hi = 0, len(frames) - 1
    while lo < hi:
        mid = (lo + hi) // 2
        if frames[mid]["t"] < ms:
            lo = mid + 1
        else:
            hi = mid
    cand = [frames[max(0, lo - 1)], frames[lo]]
    return min(cand, key=lambda f: abs(f["t"] - ms))


class Compositor:
    def __init__(self, job):
        self.job = job
        self.W = job["size"]["width"]
        self.H = job["size"]["height"]
        self.fps = job["fps"]

        # ── 外壳模板 ──
        self.tpl = load_template(job.get("template"))

        tb = self.tpl["topbar"]
        self.topbar_h = int(round(self.H * tb["height"] / self.tpl["canvas"]["height"])) if tb.get("show", True) else 0
        self.body_h = self.H - self.topbar_h

        self.shot = job["shot"]
        self.rec = job["recording"]
        self.stages = job.get("stages") or []
        self.all_shots = job.get("shots") or []
        self.brand = job.get("brand") or {}

        # 缩放系数：以模板基准宽度换算
        self.sc = self.W / float(self.tpl.get("scaleBase", 1920))
        def sz(base):
            return max(9, int(round(base * self.sc)))

        # 字体尺寸取自模板
        brand = tb.get("brand", {})
        stages_cfg = tb.get("stages", {})
        sub_cfg = self.tpl["subtitle"]
        self.f_title = pick_font(FONT_CANDIDATES, sz(brand.get("titleFontSize", 26)), 0)
        self.f_sub = pick_font(FONT_CANDIDATES, sz(brand.get("subtitleFontSize", 15)), 0)
        self.f_brand_icon = pick_font(FONT_CANDIDATES, sz(int(brand.get("iconSize", 50) * 0.48)), 0)
        self.f_node = pick_font(FONT_CANDIDATES, sz(stages_cfg.get("nodeFontSize", 15)), 0)
        self.f_subtitle = pick_font(FONT_CANDIDATES, sz(sub_cfg.get("fontSize", 29)), 0)
        self.f_mono = pick_font(MONO_CANDIDATES, sz(11), 0)

        # 缓存缩放后的素材帧
        self._frame_cache = {}

        # iCloud 直接读 PNG 极慢（每帧可达 3 秒），先把整批帧复制到本地临时目录
        self.local_frames = None
        self._prepare_local_frames()

    def _prepare_local_frames(self):
        """把素材帧一次性复制到本地临时目录（绕过 iCloud 慢速读取）"""
        import shutil
        src_dir = os.path.join(self.job["projectDir"], "footage", "frames")
        if not os.path.isdir(src_dir):
            return

        frames = (self.rec.get("frames") or [])
        if not frames:
            return

        # 只复制本镜头用到的帧，避免复制全部 1600+ 张
        needed = self._frames_for_shot()
        if not needed:
            return

        dst_dir = os.path.join(tempfile.gettempdir(), f"clipdesk-frames-{self.shot['id']}")
        if os.path.isdir(dst_dir):
            shutil.rmtree(dst_dir, ignore_errors=True)
        os.makedirs(dst_dir, exist_ok=True)

        for idx in needed:
            fn = f"f{idx:05d}.png"
            src = os.path.join(src_dir, fn)
            dst = os.path.join(dst_dir, fn)
            if os.path.exists(src):
                try:
                    shutil.copy2(src, dst)
                except Exception:
                    pass

        self.local_frames = dst_dir
        self._local_tmp = dst_dir

    def _frames_for_shot(self):
        """本镜头时间区间内用到的帧索引"""
        f = self.shot.get("footage")
        if not f or f.get("start") is None:
            return []
        frames = self.rec.get("frames") or []
        lo, hi = f["start"] * 1000, f["end"] * 1000
        return [fr["idx"] for fr in frames if lo - 500 <= fr["t"] <= hi + 500]

    def cleanup(self):
        """清理本地临时帧目录"""
        if getattr(self, "_local_tmp", None) and os.path.isdir(self._local_tmp):
            import shutil
            shutil.rmtree(self._local_tmp, ignore_errors=True)

    def stage_index(self):
        sid = self.shot["id"]
        for i, st in enumerate(self.stages):
            if sid in st.get("ids", []):
                return i
        return -1

    def load_frames_index(self):
        return self.rec.get("frames") or []

    def get_source_frame(self, ms):
        frames = self.load_frames_index()
        if not frames:
            return None
        f = find_frame(frames, ms)
        idx = f["idx"]
        if idx in self._frame_cache:
            return self._frame_cache[idx]
        fn = f"f{idx:05d}.png"
        p = os.path.join(self.local_frames, fn) if self.local_frames else None
        if not p or not os.path.exists(p):
            p = os.path.join(self.job["projectDir"], "footage", "frames", fn)
        if not os.path.exists(p):
            return None
        try:
            im = Image.open(p).convert("RGB")
        except Exception:
            return None
        # 缓存最多 30 张，避免内存爆
        if len(self._frame_cache) > 30:
            self._frame_cache.clear()
        self._frame_cache[idx] = im
        return im

    def compose_frame(self, t_in_shot, voice_text):
        canvas = Image.new("RGB", (self.W, self.H), self.tpl["canvas"]["background"])
        d = ImageDraw.Draw(canvas, "RGBA")

        # ── 片头 / 片尾：独立版式，不画顶栏 ──
        kind = self.shot.get("kind")
        if kind in ("intro", "outro"):
            self._draw_title_page(canvas, d, kind, t_in_shot)
            if voice_text:
                self._draw_subtitle(canvas, d, voice_text)
            return canvas

        # ── 1. 素材画面 ──
        f = self.shot.get("footage")
        if f and f.get("start") is not None:
            dur = max(0.001, self.shot.get("duration", 1))
            rel = max(0.0, min(1.0, t_in_shot / dur))
            rt = f["start"] + rel * (f["end"] - f["start"])
            src = self.get_source_frame(rt * 1000)
            if src is not None:
                scale = min(self.W / src.width, self.body_h / src.height)
                bw, bh = int(src.width * scale), int(src.height * scale)
                body = src.resize((bw, bh), Image.LANCZOS)
                canvas.paste(body, ((self.W - bw) // 2, self.topbar_h + (self.body_h - bh) // 2))
            else:
                self._draw_placeholder(canvas, d)
        else:
            self._draw_placeholder(canvas, d)

        # ── 2. 顶栏 ──
        if self.shot.get("overlay", {}).get("topbar", True):
            self._draw_topbar(canvas, d)

        # ── 3. 指针（点击后 0.45s 内）──
        self._draw_pointer(canvas, t_in_shot)

        # ── 4. 字幕 ──
        if voice_text:
            self._draw_subtitle(canvas, d, voice_text)

        return canvas

    def _draw_title_page(self, canvas, d, kind, t_in_shot):
        """片头 / 片尾标题页：图标 + 大标题 + 副标题 + 分隔线"""
        sc = self.sc
        cfg = self.tpl.get("title", {})
        brand = self.brand or {}
        W, H = self.W, self.H

        # 淡入：前 0.5 秒渐显
        dur = max(0.001, self.shot.get("duration", 1))
        alpha = min(1.0, t_in_shot / 0.5) if t_in_shot < 0.5 else 1.0
        # 淡出：最后 0.4 秒
        remain = dur - t_in_shot
        if remain < 0.4:
            alpha = min(alpha, max(0.0, remain / 0.4))

        overlay = Image.new("RGBA", (W, H), (0, 0, 0, 0))
        od = ImageDraw.Draw(overlay)

        if kind == "intro":
            title = brand.get("title", "")
            sub = brand.get("sub", "")
            extra = ""
        else:
            title = self.shot.get("overlay", {}).get("title") or brand.get("outroTitle", "科学排座位")
            sub = self.shot.get("overlay", {}).get("sub") or brand.get("outroSub", "")
            extra = self.shot.get("overlay", {}).get("meta") or brand.get("outroMeta", "")

        cx = W / 2
        icon_r = int(cfg.get("iconRadius", 56) * sc)
        icon_cy = int(H * cfg.get("iconY", 0.33))
        accent = cfg.get("iconColor", "#5b5bd6")

        # 圆形图标
        od.ellipse([cx - icon_r, icon_cy - icon_r, cx + icon_r, icon_cy + icon_r],
                   fill=accent + "ff")
        icon_font = pick_font(FONT_CANDIDATES, int(icon_r * 0.9))
        od.text((cx, icon_cy), cfg.get("iconText", "座"), font=icon_font,
                fill="#ffffff", anchor="mm")

        # 大标题
        title_font = pick_font(FONT_CANDIDATES, int(cfg.get("titleSize", 72) * sc))
        ty = icon_cy + icon_r + int(cfg.get("titleGap", 76) * sc)
        od.text((cx, ty), title, font=title_font, fill="#ffffff", anchor="mm")

        # 副标题
        if sub:
            sub_font = pick_font(FONT_CANDIDATES, int(cfg.get("subSize", 30) * sc))
            sy = ty + int(cfg.get("subGap", 62) * sc)
            od.text((cx, sy), sub, font=sub_font, fill="#8b93ad", anchor="mm")

        # 分隔线
        line_y = ty + int(cfg.get("lineGap", 108) * sc)
        line_w = int(cfg.get("lineWidth", 600) * sc)
        od.line([(cx - line_w/2, line_y), (cx + line_w/2, line_y)],
                fill=(255, 255, 255, 28), width=max(1, int(sc)))

        # 片头：四阶段预览 / 片尾：元信息
        stages = self.stages or []
        if kind == "intro" and stages:
            n = len(stages)
            gap = int(cfg.get("stageGap", 210) * sc)
            start_x = cx - gap * (n - 1) / 2
            stage_y = line_y + int(cfg.get("stageGapY", 90) * sc)
            label_font = pick_font(FONT_CANDIDATES, int(cfg.get("stageFontSize", 17) * sc))
            for i, st in enumerate(stages):
                x = start_x + i * gap
                dot_r = int(5 * sc)
                od.ellipse([x - dot_r, stage_y - dot_r, x + dot_r, stage_y + dot_r], fill=accent + "ff")
                od.text((x, stage_y + int(34 * sc)), st.get("name", ""),
                        font=label_font, fill="#8b93ad", anchor="ma")
        elif kind == "outro" and extra:
            meta_font = pick_font(FONT_CANDIDATES, int(cfg.get("metaSize", 22) * sc))
            meta_y = line_y + int(cfg.get("metaGap", 82) * sc)
            od.text((cx, meta_y), extra, font=meta_font, fill="#5d6580", anchor="mm")

        # 应用透明度
        if alpha < 1.0:
            r, g, b, a = overlay.split()
            a = a.point(lambda v: int(v * alpha))
            overlay = Image.merge("RGBA", (r, g, b, a))
        canvas.paste(Image.alpha_composite(canvas.convert("RGBA"), overlay).convert("RGB"), (0, 0))

    def _draw_placeholder(self, canvas, d):
        d.rectangle([0, self.topbar_h, self.W, self.H], fill="#141824")
        txt = "（该镜头暂无录屏素材）"
        f = pick_font(FONT_CANDIDATES, 18)
        tw = d.textlength(txt, font=f)
        d.text(((self.W - tw) / 2, self.topbar_h + self.body_h / 2), txt, font=f, fill="#5d6580")

    def _draw_topbar(self, canvas, d):
        """顶栏 + 四阶段节点图（全部参数来自模板）"""
        cfg = self.tpl["topbar"]
        if not cfg.get("show", True):
            return

        th = self.topbar_h
        sc = self.sc
        d.rectangle([0, 0, self.W, th], fill=cfg["background"])
        d.line([(0, th), (self.W, th)], fill=tuple(cfg["borderColor"]), width=1)

        # ── 品牌区 ──
        b = cfg.get("brand", {})
        if b.get("show", True):
            ix, iy = int(b["iconX"]*sc), int(b["iconY"]*sc)
            isz = int(b["iconSize"]*sc)
            d.ellipse([ix, iy, ix + isz, iy + isz], fill=b["iconColor"])
            d.text((ix + isz/2, iy + isz/2), b.get("iconText", ""),
                   font=self.f_brand_icon, fill=b["iconTextColor"], anchor="mm")

            title = self.brand.get("title", "")
            sub = self.brand.get("sub", "")
            d.text((int(b["titleX"]*sc), int(b["titleY"]*sc)), title,
                   font=self.f_title, fill=b["titleColor"])
            if sub:
                d.text((int(b["subtitleX"]*sc), int(b["subtitleY"]*sc)), sub,
                       font=self.f_sub, fill=b["subtitleColor"])

        # ── 阶段节点图 ──
        st = cfg.get("stages", {})
        if not st.get("show", True) or not self.stages:
            return

        cur = self.stage_index()
        node_r = int(st["nodeRadius"]*sc)
        gap = int(st["gap"]*sc)
        n = len(self.stages)
        total_w = gap * (n - 1)
        start_x = self.W - int(st["rightMargin"]*sc) - total_w - int(st["extraRight"]*sc)
        cy = int(st["centerY"]*sc)
        lw = max(2, int(st["lineWidth"]*sc))

        for i, stage in enumerate(self.stages):
            x = start_x + i * gap
            done = cur >= 0 and i < cur
            active = i == cur

            if i < n - 1:
                nx = start_x + (i + 1) * gap
                color = tuple(st["lineColorDone"]) if done else tuple(st["lineColorTodo"])
                d.line([(x + node_r + int(4*sc), cy), (nx - node_r - int(4*sc), cy)],
                       fill=color, width=lw)

            if active:
                pad = int(st["activeHaloPad"]*sc)
                d.ellipse([x-node_r-pad, cy-node_r-pad, x+node_r+pad, cy+node_r+pad],
                          fill=tuple(st["activeHaloColor"]))
                d.ellipse([x-node_r, cy-node_r, x+node_r, cy+node_r], fill=st["activeColor"])
                d.text((x, cy), str(i+1), font=self.f_node, fill="white", anchor="mm")
            elif done:
                d.ellipse([x-node_r, cy-node_r, x+node_r, cy+node_r], fill=st["doneColor"])
                d.text((x, cy), "✓", font=self.f_node, fill=st["doneTextColor"], anchor="mm")
            else:
                d.ellipse([x-node_r, cy-node_r, x+node_r, cy+node_r],
                          outline=tuple(st["todoBorderColor"]), width=max(2,int(2*sc)),
                          fill=tuple(st["todoFillColor"]))
                d.text((x, cy), str(i+1), font=self.f_node, fill=st["todoTextColor"], anchor="mm")

            name = stage.get("name", "")
            color = (st["labelColorActive"] if active
                     else st["labelColorDone"] if done
                     else st["labelColorTodo"])
            d.text((x, cy + int(st["labelGap"]*sc)), name, font=self.f_node,
                   fill=color, anchor="ma")

    def _draw_pointer(self, canvas, t_in_shot):
        """在点击时间附近绘制指针 + 涟漪（相对镜头时间）"""
        f = self.shot.get("footage")
        if not f:
            return
        clicks = self.rec.get("clicks") or []
        if not clicks:
            return

        win = 0.45
        for c in clicks:
            c_ms = c["t"]
            if c_ms < f["start"] * 1000 or c_ms > f["end"] * 1000:
                continue
            rt = f["start"] + (t_in_shot / max(0.001, self.shot.get("duration", 1))) * (f["end"] - f["start"])
            dt = rt - c_ms / 1000.0
            if -0.05 <= dt <= win:
                p = max(0.0, min(1.0, dt / win))
                # 素材坐标 → 画布坐标（需与素材缩放一致）
                src = self.get_source_frame(rt * 1000)
                if src is None:
                    return
                scale = min(self.W / src.width, self.body_h / src.height)
                bx = (self.W - src.width * scale) / 2
                by = self.topbar_h + (self.body_h - src.height * scale) / 2
                cx = bx + c["x"] * scale
                cy = by + c["y"] * scale
                self._paint_pointer(canvas, cx, cy, p)
                return

    def _paint_pointer(self, canvas, cx, cy, p):
        ov = Image.new("RGBA", canvas.size, (0, 0, 0, 0))
        d = ImageDraw.Draw(ov)
        # 涟漪
        for k, base_r in ((0, 12), (1, 22)):
            r = base_r + p * 18
            a = int(130 * (1 - p) * (1 - k * 0.35))
            d.ellipse([cx - r, cy - r, cx + r, cy + r], outline=(130, 148, 255, a), width=2)
        # 指针箭头
        pts = [(cx, cy), (cx, cy + 19), (cx + 5, cy + 14), (cx + 8, cy + 22),
               (cx + 12, cy + 20), (cx + 8, cy + 13), (cx + 15, cy + 13)]
        d.polygon(pts, fill=(255, 255, 255, 245), outline=(20, 20, 34, 255))
        d.line(pts + [pts[0]], fill=(20, 20, 34, 230), width=1)
        canvas.paste(Image.alpha_composite(canvas.convert("RGBA"), ov).convert("RGB"), (0, 0))

    def _draw_subtitle(self, canvas, d, text):
        """字幕：圆角条 + 文字（全部参数来自模板）"""
        cfg = self.tpl["subtitle"]
        if not cfg.get("show", True):
            return

        sc = self.sc
        f = self.f_subtitle
        max_w = self.W - int(cfg["maxWidthMargin"]*sc)

        # 换行
        lines, cur = [], ""
        for ch in text:
            if d.textlength(cur + ch, font=f) > max_w:
                lines.append(cur)
                cur = ch
            else:
                cur += ch
        if cur:
            lines.append(cur)

        radius = int(cfg["radius"]*sc)
        pad_x = int(cfg["paddingX"]*sc)
        bottom = self.H - int(cfg["bottomMargin"]*sc)
        bg = tuple(cfg["background"])

        if len(lines) == 1:
            tw = d.textlength(lines[0], font=f)
            top = bottom - int(cfg["singleLineHeight"]*sc)
            d.rounded_rectangle([(self.W - tw)/2 - pad_x, top,
                                 (self.W + tw)/2 + pad_x, bottom],
                                radius=radius, fill=bg)
            d.text((self.W/2, (top + bottom)/2), lines[0], font=f,
                   fill=cfg["color"], anchor="mm")
        else:
            lh = int(cfg["lineHeight"]*sc)
            box_h = lh * len(lines) + int(cfg["multiLinePadding"]*sc)
            tw = max(d.textlength(l, font=f) for l in lines)
            top = bottom - box_h
            d.rounded_rectangle([(self.W - tw)/2 - pad_x, top,
                                 (self.W + tw)/2 + pad_x, bottom],
                                radius=radius, fill=bg)
            y = top + int(13*sc)
            for line in lines:
                d.text((self.W/2, y + lh/2), line, font=f, fill=cfg["color"], anchor="mm")
                y += lh


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--job", required=True)
    args = ap.parse_args()

    with open(args.job, encoding="utf-8") as fh:
        job = json.load(fh)

    comp = Compositor(job)
    out_dir = job["outDir"]
    os.makedirs(out_dir, exist_ok=True)

    duration = job["shot"].get("duration", 1)
    voice = job["shot"].get("voice") or {}
    text = voice.get("text") or ""
    fps = job["fps"]
    n_frames = max(1, int(round(duration * fps)))

    for i in range(n_frames):
        t = i / fps
        img = comp.compose_frame(t, text)
        img.save(os.path.join(out_dir, f"{i:05d}.png"))

    comp.cleanup()
    print(json.dumps({"frames": n_frames, "duration": duration}))


if __name__ == "__main__":
    main()
