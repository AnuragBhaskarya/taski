import os
import sys
from PIL import Image, ImageDraw, ImageFilter, ImageFont

BASE_DIR = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
ASSETS_DIR = os.path.join(BASE_DIR, 'assets')
os.makedirs(ASSETS_DIR, exist_ok=True)

src_path = os.path.join(BASE_DIR, 'Bold White Checkmark Box.png')
if not os.path.exists(src_path):
    print(f"Error: Original image not found at {src_path}")
    sys.exit(1)

im = Image.open(src_path)
if im.mode != 'RGB':
    im = im.convert('RGB')

# 1. Save original to assets
orig_path = os.path.join(ASSETS_DIR, 'icon-original.png')
im.save(orig_path, format='PNG', optimize=True)
print(f"✓ Saved original: {orig_path}")

# 2. Standard square icon sizes
sizes = {
    'icon-512.png': 512,
    'icon-192.png': 192,
    'icon-180.png': 180, # Apple Touch Icon
    'icon-152.png': 152,
    'icon-120.png': 120,
    'icon-96.png': 96,
    'icon-72.png': 72,
    'icon-48.png': 48,
    'favicon-32x32.png': 32,
    'favicon-16x16.png': 16,
}

for name, sz in sizes.items():
    out_path = os.path.join(ASSETS_DIR, name)
    resized = im.resize((sz, sz), Image.Resampling.LANCZOS)
    resized.save(out_path, format='PNG', optimize=True)
    print(f"✓ Generated {name} ({sz}x{sz})")

# 3. Favicon.ico
ico_path = os.path.join(ASSETS_DIR, 'favicon.ico')
im.save(ico_path, format='ICO', sizes=[(16, 16), (32, 32), (48, 48)])
im.save(os.path.join(BASE_DIR, 'favicon.ico'), format='ICO', sizes=[(16, 16), (32, 32), (48, 48)])
print("✓ Generated favicon.ico in assets/ and root")

# 4. Maskable icons (pure black background #000000 with safe zone padding)
bg_color = (0, 0, 0)
for sz, name in [(512, 'icon-512-maskable.png'), (192, 'icon-192-maskable.png')]:
    maskable_canvas = Image.new('RGB', (sz, sz), bg_color)
    inner_sz = int(sz * 0.82)
    inner_im = im.resize((inner_sz, inner_sz), Image.Resampling.LANCZOS)
    offset = (sz - inner_sz) // 2
    maskable_canvas.paste(inner_im, (offset, offset))
    out_path = os.path.join(ASSETS_DIR, name)
    maskable_canvas.save(out_path, format='PNG', optimize=True)
    print(f"✓ Generated maskable {name}")

# 5. WebP optimized versions
for sz, name in [(512, 'icon-512.webp'), (192, 'icon-192.webp')]:
    out_path = os.path.join(ASSETS_DIR, name)
    resized = im.resize((sz, sz), Image.Resampling.LANCZOS)
    resized.save(out_path, format='WEBP', quality=90)
    print(f"✓ Generated WebP {name}")

# 6. Social Media Banner (1200 x 630)
W, H = 1200, 630
banner = Image.new('RGBA', (W, H), (0, 0, 0, 255))

# Radial emerald & white glow behind emblem
glow_layer = Image.new('RGBA', (W, H), (0, 0, 0, 0))
glow_draw = ImageDraw.Draw(glow_layer)
cx, cy = 275, 315

for radius in range(300, 20, -10):
    alpha = int(48 * (1 - (radius / 300.0)**1.4))
    glow_draw.ellipse([cx - radius, cy - radius, cx + radius, cy + radius], fill=(0, 230, 118, alpha))

for radius in range(160, 20, -10):
    alpha = int(32 * (1 - (radius / 160.0)**1.2))
    glow_draw.ellipse([cx - radius, cy - radius, cx + radius, cy + radius], fill=(255, 255, 255, alpha))

glow_layer = glow_layer.filter(ImageFilter.GaussianBlur(32))
banner = Image.alpha_composite(banner, glow_layer)

# Load emblem and remove near-black background
im_emblem = im.convert('RGBA')
arr = im_emblem.load()
ew, eh = im_emblem.size
for y in range(eh):
    for x in range(ew):
        r, g, b, a = arr[x, y]
        if r < 12 and g < 12 and b < 12:
            arr[x, y] = (0, 0, 0, 0)

emblem_size = 400
emblem_resized = im_emblem.resize((emblem_size, emblem_size), Image.Resampling.LANCZOS)
banner.paste(emblem_resized, (75, 115), emblem_resized)

draw = ImageDraw.Draw(banner)

# Fonts
font_title = ImageFont.truetype('/usr/share/fonts/truetype/dejavu/DejaVuSans-Bold.ttf', 82)
font_badge = ImageFont.truetype('/usr/share/fonts/truetype/dejavu/DejaVuSans-Bold.ttf', 19)
font_sub = ImageFont.truetype('/usr/share/fonts/truetype/dejavu/DejaVuSans.ttf', 25)
font_pill = ImageFont.truetype('/usr/share/fonts/truetype/dejavu/DejaVuSans-Bold.ttf', 16)

tx = 515

# Badge pill
badge_text = '✓  MINIMAL & REAL-TIME TASKS'
badge_bbox = font_badge.getbbox(badge_text)
badge_text_w = badge_bbox[2] - badge_bbox[0]
badge_w = badge_text_w + 36
badge_h = 38
badge_x, badge_y = tx, 145

draw.rounded_rectangle([badge_x, badge_y, badge_x + badge_w, badge_y + badge_h], radius=19, fill=(0, 230, 118, 22), outline=(0, 230, 118, 90), width=1)
draw.text((badge_x + 18, badge_y + 8), badge_text, fill=(0, 230, 118, 255), font=font_badge)

# Title: Taski
title_text = 'Taski'
draw.text((tx, 205), title_text, fill=(255, 255, 255, 255), font=font_title)
title_bbox = font_title.getbbox(title_text)
title_w = title_bbox[2] - title_bbox[0]

# Accent dot
dot_r = 11
dot_cx = tx + title_w + 24
dot_cy = 205 + 58
draw.ellipse([dot_cx - dot_r, dot_cy - dot_r, dot_cx + dot_r, dot_cy + dot_r], fill=(0, 230, 118, 255))

# Subtitles
draw.text((tx, 318), 'Frictionless Task Manager  •  Spring Physics', fill=(215, 220, 230, 255), font=font_sub)
draw.text((tx, 362), 'Instant Realtime Sync  •  PWA for Desktop & Mobile', fill=(140, 150, 160, 255), font=font_sub)

# Bottom feature pills
pills = [
    '⚡ Spring Physics',
    '✦ Realtime Sync',
    '✓ iOS & PWA Ready'
]
px = tx
for pill_text in pills:
    bbox = font_pill.getbbox(pill_text)
    pw = (bbox[2] - bbox[0]) + 26
    draw.rounded_rectangle([px, 442, px + pw, 482], radius=11, fill=(20, 22, 26, 255), outline=(255, 255, 255, 30), width=1)
    draw.text((px + 13, 452), pill_text, fill=(225, 232, 240, 255), font=font_pill)
    px += pw + 14

banner.convert('RGB').save(os.path.join(ASSETS_DIR, 'banner-social.jpg'), quality=95, optimize=True)
banner.save(os.path.join(ASSETS_DIR, 'banner-social.png'), optimize=True)
print("✓ Generated assets/banner-social.png and assets/banner-social.jpg")
print("\nAll assets generated successfully!")
