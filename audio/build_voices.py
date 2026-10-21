"""Dino Pals — builds dinosaur voices and nature one-shots from public-domain / CC0 animal recordings.

Usage: python3 audio/build_voices.py <raw dir> <meta.json> <out dir>
Each source file is cut into individual calls (silence detection relative to its own peak level),
then pitched/slowed for the animal's size, band-limited, faded and loudness-normalised (EBU R128).
Output: <out>/<voice>_<n>.mp3 (mono, 44.1 kHz) + <out>/voices.json (index + attribution).
"""
import json, os, re, subprocess, sys

RAW, META, OUT = sys.argv[1], sys.argv[2], sys.argv[3]
os.makedirs(OUT, exist_ok=True)
meta = json.load(open(META))

def ff(*args):
    return subprocess.run(["ffmpeg", "-hide_banner", "-nostats", *args], capture_output=True, text=True).stderr

def duration(path):
    return float(subprocess.run(["ffprobe", "-v", "error", "-show_entries", "format=duration", "-of", "csv=p=0", path], capture_output=True, text=True).stdout.strip() or 0)

def peak_db(path):
    m = re.search(r"max_volume: (-?[\d.]+) dB", ff("-i", path, "-af", "volumedetect", "-f", "null", "-"))
    return float(m.group(1)) if m else -20.0

def segments(path, below=24, min_len=0.35, max_len=4.5, gap=0.18, hp=None):
    """Non-silent intervals at (peak - below) dB."""
    thr = peak_db(path) - below
    af = (f"highpass=f={hp}," if hp else "") + f"silencedetect=noise={thr}dB:d={gap}"
    log = ff("-i", path, "-af", af, "-f", "null", "-")
    starts = [float(x) for x in re.findall(r"silence_start: (-?[\d.]+)", log)]
    ends = [float(x) for x in re.findall(r"silence_end: (-?[\d.]+)", log)]
    total = duration(path)
    # sounds are between a silence_end and the next silence_start
    edges = sorted([(0.0, "end")] + [(e, "end") for e in ends] + [(s, "start") for s in starts] + [(total, "start")])
    segs, cur = [], None
    for t, kind in edges:
        if kind == "end": cur = max(0.0, t)
        elif cur is not None:
            if t - cur >= min_len: segs.append((cur, min(t, cur + max_len)))
            cur = None
    return segs

def render(src, seg, out, rate=1.0, gain_db=0.0, hp=40, lp=None, pad=0.06, lufs=-16):
    s0, s1 = max(0.0, seg[0] - pad), seg[1] + pad
    d = (s1 - s0) / rate
    filt = [f"atrim={s0}:{s1}", "asetpts=PTS-STARTPTS", "aformat=channel_layouts=mono"]
    if rate != 1.0: filt += [f"asetrate=44100*{rate}", "aresample=44100"]
    filt += [f"highpass=f={hp}"]
    if lp: filt += [f"lowpass=f={lp}"]
    filt += [f"afade=t=in:d=0.04", f"afade=t=out:st={max(0.0, d - 0.25)}:d=0.25", f"loudnorm=I={lufs}:TP=-2:LRA=11", f"volume={gain_db}dB"]
    ff("-y", "-i", src, "-af", ",".join(filt), "-ar", "44100", "-ac", "1", "-c:a", "libmp3lame", "-b:a", "96k", out)
    return round(d, 2)

def src(name):
    return os.path.join(RAW, name.replace(" ", "_"))

# voice recipes: (source file, rate (<1 = lower/slower), lowpass, max variants, segment options)
RECIPES = {
    # big theropods: alligator bellows, lowered — the classic film-dinosaur roar, but warm, not shrill
    "bigTheropod": [("Alligatorbellow1.ogg", 0.78, 2400, 3, {"below": 12, "max_len": 2.6, "min_len": 1.0}), ("Alligatorbellowedit.ogg", 0.72, 2200, 2, {"below": 12, "max_len": 2.6, "min_len": 1.0}), ("27alligator2bellow.ogg", 0.82, 2600, 3, {"below": 14, "max_len": 2.6, "min_len": 1.0})],
    # sauropods: elephant trumpet slowed to a deep, friendly hoot + humpback breath
    "sauropod": [("Elephant voice - trumpeting.ogg", 0.5, 1800, 1, {"below": 30}), ("Elephant voice - trumpeting.ogg", 0.6, 2000, 1, {"below": 30})],
    # ceratopsians / armoured / ornithopods: bison grunt + cow moo, slightly lowered
    "ceratopsian": [("Bison.wav", 0.85, 2500, 2, {"below": 12, "max_len": 2.2}), ("Cow in Antefasy.wav", 0.8, 2200, 1, {"below": 20})],
    # raptors: great blue heron squawks
    "raptor": [("Great Blue Heron.ogg", 0.92, 7000, 3, {"below": 18}), ("Pavo cristatus (call).ogg", 0.85, 6000, 2, {"below": 22})],
    # pachycephalosaurus: turkey gobble — funny and friendly
    "chirp": [("Gobbler.ogg", 0.9, 6000, 3, {"below": 24})],
    # pterosaurs: sandhill crane rattle + gull calls
    "pterosaur": [("Yellowstone sound library - Sandhill Crane - 001.mp3", 0.9, 6000, 3, {"below": 14, "min_len": 0.5, "max_len": 2.2}), ("Gull 2.ogg", 0.85, 7000, 2, {"below": 12, "max_len": 1.4})],
    # marine reptiles: whale blows
    "marine": [("Humpback whale wheezeblow.ogg", 1.0, 3000, 3, {"below": 20, "min_len": 0.6})],
}
# nature one-shots / beds for the ambience
AMBIENT = {
    "meadow_bird": [("Yellowstone sound library - Mountain Bluebird - 001.mp3", 1.0, None, 4, {"below": 22, "min_len": 0.3, "hp": 1500}), ("Yellowstone sound library - Red-Winged Blackbird - 001.mp3", 1.0, None, 3, {"below": 20, "min_len": 0.4, "hp": 1200})],
    "jungle_bird": [("LaughingKookaburra.ogg", 1.0, None, 1, {"below": 30, "max_len": 6, "min_len": 1.5}), ("Yellow-tailed Black Cockatoos.ogg", 1.0, None, 3, {"below": 18})],
    "lake_bird": [("Yellowstone sound library - Common Loon - 001.mp3", 1.0, None, 3, {"below": 18, "min_len": 1.0, "max_len": 6}), ("Yellowstone sound library - Canada Geese - 001.mp3", 1.0, None, 2, {"below": 16, "min_len": 0.6})],
    "beach_bird": [("XC707075 - European Herring Gull - Larus argentatus.mp3", 1.0, None, 4, {"below": 18}), ("Gull 1.ogg", 1.0, None, 2, {"below": 18})],
}

index, credits = {}, {}
for group in (RECIPES, AMBIENT):
    for voice, recipe in group.items():
        index[voice] = []
        for name, rate, lp, n, opt in recipe:
            path = src(name)
            if not os.path.exists(path): print("missing", path); continue
            segs = segments(path, **opt)
            # loudest-longest first: prefer full calls
            segs = sorted(segs, key=lambda s: -(s[1] - s[0]))[: n * 2]
            segs = sorted(segs, key=lambda s: s[0])[:n] if len(segs) > n else segs
            for seg in segs:
                k = len(index[voice])
                out = os.path.join(OUT, f"{voice}_{k}.mp3")
                d = render(path, seg, out, rate=rate, lp=lp, lufs=-16 if group is RECIPES else -22)
                index[voice].append({"file": os.path.basename(out), "dur": d, "src": name})
            m = meta.get(name, {})
            credits[name] = {"license": m.get("license", ""), "author": m.get("artist", ""), "url": m.get("url", "")}
        print(f"{voice:12s} {len(index[voice])} clips", [c["dur"] for c in index[voice]])

json.dump({"voices": index, "credits": credits}, open(os.path.join(OUT, "voices.json"), "w"), indent=1)
tot = sum(os.path.getsize(os.path.join(OUT, f)) for f in os.listdir(OUT) if f.endswith(".mp3"))
print("total", round(tot / 1e6, 2), "MB")
