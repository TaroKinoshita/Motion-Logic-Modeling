"""1c の受け入れ試験用サンプル映像（約10秒・1280x720・30fps・120BPM）を生成する。

本物の作品ではなく、リリックモーションでよく使う表現を意図的に詰め込んだ合成映像。
生成パラメータ（正解）を ground_truth.json に書き出し、簡略シーンの再現度を数値で比べられるようにする。

使い方: python samples/make_kinetic_sample.py <出力フォルダ>
必要: Pillow, numpy, ffmpeg（PATH上）
"""
import json
import math
import random
import subprocess
import sys
import wave
from pathlib import Path

import numpy as np
from PIL import Image, ImageDraw, ImageFont

W, H, FPS, DUR = 1280, 720, 30, 10.0
BPM = 120
BEAT = 60 / BPM
OUT = Path(sys.argv[1] if len(sys.argv) > 1 else "samples/out")
OUT.mkdir(parents=True, exist_ok=True)
FONT = ImageFont.truetype("C:/Windows/Fonts/arialbd.ttf", 120)
FONT_BIG = ImageFont.truetype("C:/Windows/Fonts/arialbd.ttf", 200)
FONT_MID = ImageFont.truetype("C:/Windows/Fonts/arialbd.ttf", 90)


def clamp(x, a=0.0, b=1.0):
    return max(a, min(b, x))


def ease_out_back(p, s=1.70158):
    p -= 1
    return p * p * ((s + 1) * p + s) + 1


def ease_out_cubic(p):
    return 1 - (1 - p) ** 3


def ease_in_out(p):
    return 3 * p * p - 2 * p * p * p


def prog(t, start, dur):
    return clamp((t - start) / dur)


GT = {"size": [W, H], "fps": FPS, "duration": DUR, "bpm": BPM, "sections": [], "elements": []}


def gt(section, desc):
    GT["sections"].append({"t": section, "desc": desc})


gt([0, 2], "MOTION が1文字ずつ下から登場（0.06秒間隔、0.35秒、easeOutBack）。0.8〜1.4秒で下線が中央から伸びる")
gt([2, 4], "MOTION が上へ移動（2.0〜2.4秒）。LOGIC が8分音符ごと（0.25秒間隔）に1文字ずつ上から落ちる。左の正方形が2秒で1回転し続ける")
gt([4, 4.5], "タメ：全体が 1.0→0.95 に縮み、動きが止まる。キックも止まる")
gt([4.5, 4.5], "白フラッシュ2フレーム＋カット（背景が黄色に）")
gt([4.5, 6], "BREAK が 3.0→1.0 倍に 0.3秒で縮んで着地。中央から粒子40個が放射状に飛び、減速しながら1秒で消える")
gt([6, 8], "カメラが 1.0→1.15 へゆっくりズーム。3つの円が拍ごとに 1→1.3→1 と脈動")
gt([8, 10], "カット（黒背景）。NEW SONG がタイプライター表示（0.08秒/文字）、カーソル点滅。9.5秒から全体フェードアウト")
GT["beats"] = [round(i * BEAT, 3) for i in range(int(DUR / BEAT))]
GT["cuts"] = [4.5, 8.0]

random.seed(7)
PARTICLES = [(random.uniform(0, 2 * math.pi), random.uniform(250, 520), random.uniform(5, 12)) for _ in range(40)]


def text_w(font, s):
    return font.getbbox(s)[2] - font.getbbox(s)[0]


def draw_chars(d, font, word, cx, cy, per_char):
    """per_char(i) -> (dx, dy, alpha) で1文字ずつ描く。"""
    total = text_w(font, word)
    x = cx - total / 2
    for i, ch in enumerate(word):
        dx, dy, a = per_char(i)
        if a > 0:
            d.text((x + dx, cy + dy), ch, font=font, fill=(255, 255, 255, int(255 * a)), anchor="lm")
        x += text_w(font, ch) + 4


def frame(t):
    if t < 4.5:
        bg = (16, 20, 40)
    elif t < 8.0:
        bg = (250, 205, 40)
    else:
        bg = (0, 0, 0)
    img = Image.new("RGBA", (W, H), bg + (255,))
    layer = Image.new("RGBA", (W, H), (0, 0, 0, 0))
    d = ImageDraw.Draw(layer)

    if t < 4.5:
        # 2.0〜2.4秒で MOTION が上へ
        up = ease_in_out(prog(t, 2.0, 0.4)) * -110
        def motion_char(i):
            p = prog(t, 0.2 + i * 0.06, 0.35)
            return 0, (1 - ease_out_back(p)) * 120 + up, clamp(p * 3)
        draw_chars(d, FONT, "MOTION", W / 2, H / 2 + up * 0 , motion_char)
        # 下線
        lw = ease_in_out(prog(t, 0.8, 0.6)) * 600
        if lw > 0:
            y = H / 2 + 80 + up
            d.rectangle([W / 2 - lw / 2, y, W / 2 + lw / 2, y + 8], fill=(255, 90, 120, 255))
        # LOGIC：2.0秒から8分音符ごと
        def logic_char(i):
            p = prog(t, 2.0 + i * BEAT / 2, 0.2)
            return 0, (1 - ease_out_cubic(p)) * -260 + 90, 1.0 if p > 0 else 0.0
        draw_chars(d, FONT, "LOGIC", W / 2, H / 2, logic_char)
        # 回る正方形（2.0秒から。タメ中は止まる）
        if t >= 2.0:
            ang = (min(t, 4.0) - 2.0) * 180
            s = 50
            cx, cy = 180, H / 2 + 40
            pts = [(cx + s * math.cos(math.radians(ang + k)), cy + s * math.sin(math.radians(ang + k))) for k in (45, 135, 225, 315)]
            d.polygon(pts, fill=(80, 200, 255, 255))
        # タメ：4.0〜4.5秒で 0.95 倍へ
        sc = 1 - 0.05 * ease_in_out(prog(t, 4.0, 0.5))
        if sc < 1:
            layer = layer.resize((int(W * sc), int(H * sc)), Image.BICUBIC)
            pad = Image.new("RGBA", (W, H), (0, 0, 0, 0))
            pad.paste(layer, ((W - layer.width) // 2, (H - layer.height) // 2))
            layer = pad
    elif t < 8.0:
        # 粒子
        pt = t - 4.5
        if pt < 1.0:
            for ang, speed, r in PARTICLES:
                dist = speed * (1 - (1 - pt) ** 2) / 2 * 2
                x, y = W / 2 + math.cos(ang) * dist, H / 2 + math.sin(ang) * dist
                a = int(255 * (1 - pt))
                d.ellipse([x - r, y - r, x + r, y + r], fill=(255, 255, 255, a))
        # 脈動する円（6.0秒から）
        if t >= 6.0:
            for k, cx in enumerate((340, 640, 940)):
                bp = ((t - 6.0) % BEAT) / BEAT
                s = 1 + 0.3 * math.sin(math.pi * clamp(bp / 0.5))
                r = 40 * s
                cy = 560
                d.ellipse([cx - r, cy - r, cx + r, cy + r], outline=(30, 30, 30, 255), width=8)
        # BREAK
        p = prog(t, 4.5, 0.3)
        s = 3.0 - 2.0 * ease_out_cubic(p)
        word = Image.new("RGBA", (W, H), (0, 0, 0, 0))
        ImageDraw.Draw(word).text((W / 2, H / 2 - 40), "BREAK", font=FONT_BIG, fill=(20, 20, 20, 255), anchor="mm")
        ww, wh = int(W * s), int(H * s)
        word = word.resize((ww, wh), Image.BICUBIC)
        layer.alpha_composite(word.crop(((ww - W) // 2, (wh - H) // 2, (ww - W) // 2 + W, (wh - H) // 2 + H)) if s >= 1 else word)
        # カメラズーム 6.0〜8.0
        z = 1 + 0.15 * ease_in_out(prog(t, 6.0, 2.0))
        if z > 1:
            full = Image.new("RGBA", (W, H), bg + (255,))
            full.alpha_composite(layer)
            zw, zh = int(W * z), int(H * z)
            full = full.resize((zw, zh), Image.BICUBIC).crop(((zw - W) // 2, (zh - H) // 2, (zw - W) // 2 + W, (zh - H) // 2 + H))
            img = full
            layer = Image.new("RGBA", (W, H), (0, 0, 0, 0))
    else:
        text = "NEW SONG"
        n = int(clamp((t - 8.2) / 0.08, 0, len(text)))
        shown = text[:n]
        x0 = W / 2 - text_w(FONT_MID, text) / 2
        d.text((x0, H / 2), shown, font=FONT_MID, fill=(255, 255, 255, 255), anchor="lm")
        if int(t / 0.25) % 2 == 0:
            cx = x0 + (text_w(FONT_MID, shown) if shown else 0) + 8
            d.rectangle([cx, H / 2 - 45, cx + 10, H / 2 + 45], fill=(255, 255, 255, 255))

    img.alpha_composite(layer)
    # フラッシュ（4.5秒から2フレーム）
    if 4.5 <= t < 4.5 + 2 / FPS:
        img = Image.new("RGBA", (W, H), (255, 255, 255, 255))
    # フェードアウト
    f = 1 - prog(t, 9.5, 0.5)
    if f < 1:
        img = Image.blend(Image.new("RGBA", (W, H), (0, 0, 0, 255)), img, f)
    return img.convert("RGB")


def make_audio(path):
    sr = 44100
    n = int(DUR * sr)
    a = np.zeros(n)
    tt = np.arange(int(0.25 * sr)) / sr
    kick = np.sin(2 * np.pi * (50 + 120 * np.exp(-tt * 30)) * tt) * np.exp(-tt * 12)
    snare = np.random.default_rng(1).normal(0, 1, len(tt)) * np.exp(-tt * 25) * 0.5
    for i, bt in enumerate(GT["beats"]):
        if 4.0 <= bt < 4.5:
            continue  # タメ：キックを止める
        s = int(bt * sr)
        a[s:s + len(kick)] += kick[: n - s]
        if i % 2 == 1:
            a[s:s + len(snare)] += snare[: n - s]
    # 4.0〜4.5秒のライザー
    rs, re_ = int(4.0 * sr), int(4.5 * sr)
    rt = np.arange(re_ - rs) / sr
    a[rs:re_] += np.sin(2 * np.pi * (300 + 1500 * rt / 0.5) * rt) * (rt / 0.5) * 0.4
    # 4.5秒のクラッシュ
    ct = np.arange(int(1.5 * sr)) / sr
    cs = int(4.5 * sr)
    a[cs:cs + len(ct)] += np.random.default_rng(2).normal(0, 1, len(ct)) * np.exp(-ct * 3) * 0.6
    a *= 1 - np.clip((np.arange(n) / sr - 9.5) / 0.5, 0, 1)
    a = np.clip(a / np.max(np.abs(a)) * 0.9, -1, 1)
    with wave.open(str(path), "wb") as w:
        w.setnchannels(1)
        w.setsampwidth(2)
        w.setframerate(sr)
        w.writeframes((a * 32767).astype(np.int16).tobytes())


wav = OUT / "audio.wav"
make_audio(wav)
mp4 = OUT / "kinetic_sample.mp4"
ff = subprocess.Popen(
    ["ffmpeg", "-v", "error", "-y", "-f", "rawvideo", "-pix_fmt", "rgb24", "-s", f"{W}x{H}", "-r", str(FPS), "-i", "pipe:0",
     "-i", str(wav), "-map", "0:v", "-map", "1:a", "-c:v", "libx264", "-pix_fmt", "yuv420p", "-crf", "18", "-c:a", "aac",
     "-frames:v", str(int(DUR * FPS)), str(mp4)],
    stdin=subprocess.PIPE,
)
for i in range(int(DUR * FPS)):
    ff.stdin.write(frame(i / FPS).tobytes())
ff.stdin.close()
ff.wait()
wav.unlink()
(OUT / "ground_truth.json").write_text(json.dumps(GT, ensure_ascii=False, indent=2), encoding="utf-8")
print(mp4)
