"""Download the VALORANT rank icons used by the "Enemy rank" setting and Studio's rank picker.

Run once (needs internet and Pillow); the PNGs are committed, so the app stays offline:

    python -I tools/fetch_rank_icons.py

Source: valorant-api.com's competitivetiers endpoint (the newest tier set, top division of each
rank, Radiant's single icon), scaled from 256 px to 128 px. The art belongs to Riot Games and is
used under Riot's "Legal Jibber Jabber" fan-content policy, see app/mods/aim-ranks/README.md.
"""
import io
import json
import os
import urllib.request

from PIL import Image

HERE = os.path.dirname(os.path.abspath(__file__))
OUT = os.path.join(HERE, "..", "app", "mods", "aim-ranks")
API = "https://valorant-api.com/v1/competitivetiers"
# rank id -> tier name in the newest tier set
RANKS = {
    "iron": "IRON 3", "bronze": "BRONZE 3", "silver": "SILVER 3", "gold": "GOLD 3",
    "platinum": "PLATINUM 3", "diamond": "DIAMOND 3", "ascendant": "ASCENDANT 3",
    "immortal": "IMMORTAL 3", "radiant": "RADIANT",
}
SIZE = 128


def get(url):
    req = urllib.request.Request(url, headers={"User-Agent": "open-aim-tools"})
    with urllib.request.urlopen(req, timeout=30) as r:
        return r.read()


tiers = json.loads(get(API))["data"][-1]["tiers"]
by_name = {t["tierName"]: t for t in tiers}
os.makedirs(OUT, exist_ok=True)
for rid, name in RANKS.items():
    tier = by_name[name]
    img = Image.open(io.BytesIO(get(tier["largeIcon"]))).convert("RGBA")
    img.thumbnail((SIZE, SIZE), Image.LANCZOS)
    path = os.path.join(OUT, rid + ".png")
    img.save(path, optimize=True)
    print(rid, tier["tier"], img.size, os.path.getsize(path), "bytes")
