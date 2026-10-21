import os
import json
import requests
import time

CATBOX_API = 'https://catbox.moe/user/api.php'
ASSETS_DIR = os.path.join(os.path.dirname(os.path.dirname(os.path.abspath(__file__))), 'assets')
OUT_FILE = os.path.join(ASSETS_DIR, 'catbox_urls.json')

files_to_upload = [
    'icon-original.png',
    'icon-512.png',
    'icon-192.png',
    'icon-180.png',
    'favicon-32x32.png',
    'favicon.ico',
    'banner-social.png'
]

catbox_results = {}
if os.path.exists(OUT_FILE):
    try:
        with open(OUT_FILE, 'r') as f:
            catbox_results = json.load(f)
    except Exception:
        pass

print("Starting Catbox media upload...")
for fname in files_to_upload:
    fpath = os.path.join(ASSETS_DIR, fname)
    if not os.path.exists(fpath):
        print(f"Skipping {fname}: file not found at {fpath}")
        continue
    
    if fname in catbox_results and catbox_results[fname].startswith('https://files.catbox.moe/'):
        print(f"Already uploaded {fname} -> {catbox_results[fname]}")
        continue

    print(f"Uploading {fname} to Catbox ({CATBOX_API})...")
    uploaded = False
    for attempt in range(1, 3):
        try:
            with open(fpath, 'rb') as f:
                resp = requests.post(
                    CATBOX_API,
                    data={'reqtype': 'fileupload'},
                    files={'fileToUpload': (fname, f)},
                    timeout=15,
                    headers={'User-Agent': 'Mozilla/5.0'}
                )
                if resp.status_code == 200 and resp.text.startswith('http'):
                    url = resp.text.strip()
                    catbox_results[fname] = url
                    print(f"✓ Uploaded {fname} -> {url}")
                    uploaded = True
                    break
                else:
                    print(f"Attempt {attempt}: Response {resp.status_code}: {resp.text}")
        except Exception as e:
            print(f"Attempt {attempt} failed for {fname}: {e}")
        time.sleep(1)

    if not uploaded:
        print(f"Notice: Catbox is currently unreachable for {fname}. Using local asset path fallback.")

with open(OUT_FILE, 'w') as out:
    json.dump(catbox_results, out, indent=2)

print(f"\nUpload state saved to {OUT_FILE}")
