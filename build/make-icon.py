"""生成 SkillSwitch 图标：渐变圆角底 + 白色闪电，输出 ico / png。"""
from PIL import Image, ImageDraw, ImageFilter
import os

OUT = r"C:\Users\mmm\Documents\deepseek-harness\default-workspace\skillswitch-fixed\build\icon"
os.makedirs(OUT, exist_ok=True)

S = 1024
SS = 4  # 超采样倍数
W = S * SS

# 1) 对角渐变底
grad = Image.new("RGB", (W, W))
d = ImageDraw.Draw(grad)
c1 = (0x5B, 0x8C, 0xFF)
c2 = (0x8B, 0x5B, 0xFF)
for i in range(W * 2):
    t = i / (W * 2 - 1)
    col = tuple(int(c1[k] + (c2[k] - c1[k]) * t) for k in range(3))
    d.line([(i, 0), (0, i)], fill=col)

# 2) 圆角遮罩
mask = Image.new("L", (W, W), 0)
md = ImageDraw.Draw(mask)
r = int(W * 0.22)
md.rounded_rectangle([0, 0, W - 1, W - 1], radius=r, fill=255)

icon = Image.new("RGBA", (W, W), (0, 0, 0, 0))
icon.paste(grad, (0, 0), mask)

# 3) 顶部高光
hl = Image.new("RGBA", (W, W), (0, 0, 0, 0))
hd = ImageDraw.Draw(hl)
hd.rounded_rectangle([0, 0, W - 1, W - 1], radius=r, fill=(255, 255, 255, 34))
hl = hl.filter(ImageFilter.GaussianBlur(W * 0.03))
icon = Image.alpha_composite(icon, Image.composite(hl, Image.new("RGBA", (W, W), (0, 0, 0, 0)), mask))

# 4) 闪电（明显加粗，小尺寸也认得出）
pts = [(0.575, 0.105), (0.245, 0.575), (0.455, 0.575), (0.375, 0.895), (0.760, 0.415), (0.535, 0.415)]
poly = [(x * W, y * W) for x, y in pts]
shadow = Image.new("RGBA", (W, W), (0, 0, 0, 0))
sd = ImageDraw.Draw(shadow)
sd.polygon([(x + W * 0.012, y + W * 0.014) for x, y in poly], fill=(20, 10, 60, 90))
shadow = shadow.filter(ImageFilter.GaussianBlur(W * 0.02))
icon = Image.alpha_composite(icon, Image.composite(shadow, Image.new("RGBA", (W, W), (0, 0, 0, 0)), mask))

bolt = Image.new("RGBA", (W, W), (0, 0, 0, 0))
bd = ImageDraw.Draw(bolt)
bd.polygon(poly, fill=(255, 255, 255, 255))
bd.line(poly + [poly[0]], fill=(255, 255, 255, 255), width=int(W * 0.012), joint="curve")
icon = Image.alpha_composite(icon, bolt)

# 5) 缩回目标尺寸
master = icon.resize((S, S), Image.LANCZOS)
master.save(os.path.join(OUT, "icon-1024.png"))
master.resize((512, 512), Image.LANCZOS).save(os.path.join(OUT, "icon-512.png"))
master.resize((128, 128), Image.LANCZOS).save(os.path.join(OUT, "icon-128.png"))

ico_sizes = [(256, 256), (128, 128), (64, 64), (48, 48), (40, 40), (32, 32), (24, 24), (16, 16)]
master.save(os.path.join(OUT, "icon.ico"), format="ICO", sizes=ico_sizes)
print("ok", os.path.join(OUT, "icon.ico"), os.path.getsize(os.path.join(OUT, "icon.ico")))
