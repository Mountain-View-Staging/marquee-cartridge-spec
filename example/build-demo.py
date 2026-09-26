#!/usr/bin/env python3
"""
Builds the demo show served from this repository's GitHub Pages site: two
v25.0.1 cartridges and the media they name.

Everything here is REAL: the DDL is the specification's (README §4) verbatim,
the two .db files are ordinary SQLite databases shaped the way a publisher
shapes them, and every file the manifest lists exists beside them with the
size and SHA-256 the manifest says. The reference player and the explorer read
them with no special cases.

    python3 build-demo.py

It rewrites SHOW26/ from scratch. Nothing else in the repository is touched.
No dependencies beyond python3; ffmpeg is optional and only for the video item
(without it the demo builds image-only rather than failing).

The content is chosen so the rules that are easiest to get wrong are VISIBLE:

  per-slot resolution    the landscape and portrait lanes run different playlists
  takeover + the cut     SAFETY NOTICE takes over both lanes 12:00-14:00 on Day 1,
                         cutting whatever is on screen at 12:00:00
  cursor resume          at 14:00 the notice finishes its time, then the standard
                         rotation resumes after the entry it cut, not at the top
  day-scoped directives  RECEPTION turns on at 17:00 on Day 1 with no OFF; on
                         Day 2 it is not on, because Day 1's directive stays in Day 1
  empty orientation slot WAYFINDING has only a portrait file, so the landscape
                         playlist skips it
  a slot plays as authored  SPONSORS' portrait slot holds its landscape file, so a
                         portrait Surface shows a landscape image, letterboxed over
                         the project's backing
  an authored blank      from 18:00 on Day 2 both lanes are scheduled with no
                         playlist: the screen clears
  a trimmed video        the landscape SIZZLE REEL plays 1 s to 5 s of a 6 s clip
  a session board        MAIN HALL, over its own backing

Day 1 is 2026-10-05, Day 2 2026-10-06, in America/Los_Angeles. Outside those
days a Surface shows Day 1 at the venue's current time of day (§8.2).
"""

import hashlib
import os
import shutil
import sqlite3
import struct
import subprocess
import tempfile
import uuid
import zlib
from datetime import datetime
from zoneinfo import ZoneInfo

HERE = os.path.dirname(os.path.abspath(__file__))
SHOW = "SHOW26"
SURFACE = "DEMO1"
OUT = os.path.join(HERE, SHOW)

TZ = "America/Los_Angeles"
Z = ZoneInfo(TZ)
DAYS = ["2026-10-05", "2026-10-06"]
FORMAT_VERSION = "25.0.1"
VIDEO_SECONDS = 6
# Fixed stamps keep rebuilds byte-stable in content.
GENERATED_AT = 1791097200000          # 2026-10-04 00:00 PDT
NAMES = uuid.UUID("5b1e2c1a-2f0e-4c47-9a53-6a2d8f3c0e26")   # namespace for file names


def ms(local):
    """'2026-10-05 12:00:00' in the venue timezone -> Unix ms."""
    return int(datetime.strptime(local, "%Y-%m-%d %H:%M:%S").replace(tzinfo=Z).timestamp() * 1000)


def day_window(d):
    return ms(d + " 00:00:00"), ms(d + " 23:59:59") + 999


# --------------------------------------------------------------------------
# The v25.0.1 wire format, verbatim from the specification (README §4).
# --------------------------------------------------------------------------

DDL = {
    "cartridge_meta": """CREATE TABLE cartridge_meta (
  cartridge_kind     TEXT    NOT NULL,
  format_version     TEXT    NOT NULL,
  project_code       TEXT    NOT NULL,
  surface_id         TEXT,
  published_revision INTEGER NOT NULL,
  timezone           TEXT    NOT NULL,
  generated_at       INTEGER NOT NULL
)""",
    "media_manifest": """CREATE TABLE media_manifest (
  media_file_id         INTEGER NOT NULL UNIQUE REFERENCES media_file(id),
  deliverable_file_name TEXT    NOT NULL,
  content_hash          TEXT    NOT NULL,
  file_size             INTEGER NOT NULL,
  content_type          TEXT    NOT NULL
)""",
    "project": """CREATE TABLE project (
  id                        INTEGER PRIMARY KEY,
  cloud_uid                 TEXT    NOT NULL,
  name                      TEXT    NOT NULL,
  project_code              TEXT    NOT NULL,
  timezone                  TEXT    NOT NULL,
  show_wallpaper_item_id    INTEGER REFERENCES media_item(id),
  desktop_wallpaper_item_id INTEGER REFERENCES media_item(id),
  backing_item_id           INTEGER REFERENCES media_item(id),
  brand_style               TEXT,
  brand_style_item_id       INTEGER REFERENCES media_item(id),
  created                   INTEGER NOT NULL,
  updated                   INTEGER NOT NULL
)""",
    "project_days": """CREATE TABLE project_days (
  id         INTEGER PRIMARY KEY,
  day        TEXT    NOT NULL UNIQUE,
  start_time INTEGER NOT NULL,
  end_time   INTEGER NOT NULL,
  created    INTEGER NOT NULL,
  updated    INTEGER NOT NULL
)""",
    "surface_config": """CREATE TABLE surface_config (
  id                 INTEGER PRIMARY KEY,
  name               TEXT    NOT NULL,
  surface_id         TEXT    NOT NULL,
  published_revision INTEGER NOT NULL,
  published_at       INTEGER NOT NULL,
  created            INTEGER NOT NULL,
  updated            INTEGER NOT NULL
)""",
    "surface_location": """CREATE TABLE surface_location (
  id          INTEGER PRIMARY KEY,
  config_id   INTEGER NOT NULL REFERENCES surface_config(id),
  location_id TEXT    NOT NULL UNIQUE,
  orientation TEXT    NOT NULL,
  label       TEXT,
  created     INTEGER NOT NULL,
  updated     INTEGER NOT NULL
)""",
    "surface_schedule_entry": """CREATE TABLE surface_schedule_entry (
  id                 INTEGER PRIMARY KEY,
  config_id          INTEGER NOT NULL REFERENCES surface_config(id),
  slot               TEXT    NOT NULL,
  timestamp          INTEGER NOT NULL,
  playlist_id        INTEGER REFERENCES playlist(id),
  background_item_id INTEGER REFERENCES media_item(id),
  overlay_item_id    INTEGER REFERENCES media_item(id),
  created            INTEGER NOT NULL,
  updated            INTEGER NOT NULL,
  CHECK (
    ( slot IN ('portrait','landscape')
        AND background_item_id IS NULL AND overlay_item_id IS NULL )
    OR
    ( slot = 'demo_station'
        AND playlist_id IS NULL
        AND ( background_item_id IS NOT NULL OR overlay_item_id IS NULL ) )
  )
)""",
    "playlist": """CREATE TABLE playlist (
  id              INTEGER PRIMARY KEY,
  name            TEXT    NOT NULL,
  created         INTEGER NOT NULL,
  updated         INTEGER NOT NULL
)""",
    "playlist_entry": """CREATE TABLE playlist_entry (
  id                   INTEGER PRIMARY KEY,
  playlist_id          INTEGER NOT NULL REFERENCES playlist(id),
  position             INTEGER NOT NULL,
  resource_type        TEXT    NOT NULL,
  media_item_id        INTEGER REFERENCES media_item(id),
  session_set_id       INTEGER REFERENCES session_set(id),
  start_time_portrait  REAL,
  end_time_portrait    REAL,
  start_time_landscape REAL,
  end_time_landscape   REAL,
  created              INTEGER NOT NULL,
  updated              INTEGER NOT NULL,
  CHECK (resource_type <> 'media_item'  OR media_item_id  IS NOT NULL),
  CHECK (resource_type <> 'session_set' OR session_set_id IS NOT NULL)
)""",
    "directive": """CREATE TABLE directive (
  id        INTEGER PRIMARY KEY,
  entry_id  INTEGER NOT NULL REFERENCES playlist_entry(id),
  type      TEXT    NOT NULL,
  timestamp INTEGER NOT NULL,
  on_screen INTEGER NOT NULL,
  timezone  TEXT,
  created   INTEGER NOT NULL,
  updated   INTEGER NOT NULL
)""",
    "media_item": """CREATE TABLE media_item (
  id                INTEGER PRIMARY KEY,
  name              TEXT    NOT NULL,
  portrait_file_id  INTEGER REFERENCES media_file(id),
  landscape_file_id INTEGER REFERENCES media_file(id),
  display_duration  REAL,
  brand_member      TEXT,
  created           INTEGER NOT NULL,
  updated           INTEGER NOT NULL,
  CHECK (portrait_file_id IS NOT NULL OR landscape_file_id IS NOT NULL)
)""",
    "media_file": """CREATE TABLE media_file (
  id                 INTEGER PRIMARY KEY,
  content_type       TEXT    NOT NULL,
  codec              TEXT,
  width              INTEGER,
  height             INTEGER,
  orientation        TEXT,
  aspect_ratio       REAL,
  intrinsic_duration REAL,
  created            INTEGER NOT NULL,
  updated            INTEGER NOT NULL
)""",
    "session": """CREATE TABLE session (
  id          INTEGER PRIMARY KEY,
  name        TEXT    NOT NULL,
  abstract    TEXT,
  presenters  TEXT,
  attributes  TEXT,
  source_id   TEXT,
  source_type TEXT,
  source_name TEXT,
  created     INTEGER NOT NULL,
  updated     INTEGER NOT NULL
)""",
    "session_set": """CREATE TABLE session_set (
  id                INTEGER PRIMARY KEY,
  name              TEXT    NOT NULL,
  render_modes      TEXT    NOT NULL DEFAULT '["simple"]',
  duration          REAL    NOT NULL DEFAULT 8,
  backing_item_id   INTEGER REFERENCES media_item(id),
  logo_item_id      INTEGER REFERENCES media_item(id),
  schedule_template TEXT,
  source_id         TEXT,
  source_name       TEXT,
  brand_style         TEXT,
  brand_style_item_id INTEGER REFERENCES media_item(id),
  created           INTEGER NOT NULL,
  updated           INTEGER NOT NULL
)""",
    "session_set_entry": """CREATE TABLE session_set_entry (
  id              INTEGER PRIMARY KEY,
  session_set_id  INTEGER NOT NULL REFERENCES session_set(id),
  session_id      INTEGER NOT NULL REFERENCES session(id),
  session_time_id TEXT,
  start_time      INTEGER NOT NULL,
  end_time        INTEGER NOT NULL,
  source_room_id  TEXT,
  room_name       TEXT,
  created         INTEGER NOT NULL,
  updated         INTEGER NOT NULL
)""",
    "media_file_variant": """CREATE TABLE media_file_variant (
  id            INTEGER PRIMARY KEY,
  media_file_id INTEGER NOT NULL REFERENCES media_file(id),
  kind          TEXT    NOT NULL,
  file_name     TEXT    NOT NULL,
  content_type  TEXT    NOT NULL,
  codec         TEXT,
  width         INTEGER,
  height        INTEGER,
  file_size     INTEGER NOT NULL,
  content_hash  TEXT    NOT NULL,
  created       INTEGER NOT NULL,
  updated       INTEGER NOT NULL
)""",
}

PROJECT_TABLES = ["cartridge_meta", "project", "project_days", "media_item", "media_file",
                  "media_file_variant", "media_manifest"]
SURFACE_TABLES = PROJECT_TABLES + ["surface_config", "surface_location", "surface_schedule_entry",
                                   "playlist", "playlist_entry", "directive",
                                   "session", "session_set", "session_set_entry"]


# --------------------------------------------------------------------------
# Pictures: PNGs with a label, written with no dependencies.
# --------------------------------------------------------------------------

GLYPHS = {
    "A": [".###.", "#...#", "#...#", "#####", "#...#", "#...#", "#...#"],
    "B": ["####.", "#...#", "#...#", "####.", "#...#", "#...#", "####."],
    "C": [".###.", "#...#", "#....", "#....", "#....", "#...#", ".###."],
    "D": ["###..", "#..#.", "#...#", "#...#", "#...#", "#..#.", "###.."],
    "E": ["#####", "#....", "#....", "####.", "#....", "#....", "#####"],
    "F": ["#####", "#....", "#....", "####.", "#....", "#....", "#...."],
    "G": [".###.", "#...#", "#....", "#.###", "#...#", "#...#", ".####"],
    "H": ["#...#", "#...#", "#...#", "#####", "#...#", "#...#", "#...#"],
    "I": [".###.", "..#..", "..#..", "..#..", "..#..", "..#..", ".###."],
    "J": ["..###", "...#.", "...#.", "...#.", "...#.", "#..#.", ".##.."],
    "K": ["#...#", "#..#.", "#.#..", "##...", "#.#..", "#..#.", "#...#"],
    "L": ["#....", "#....", "#....", "#....", "#....", "#....", "#####"],
    "M": ["#...#", "##.##", "#.#.#", "#.#.#", "#...#", "#...#", "#...#"],
    "N": ["#...#", "#...#", "##..#", "#.#.#", "#..##", "#...#", "#...#"],
    "O": [".###.", "#...#", "#...#", "#...#", "#...#", "#...#", ".###."],
    "P": ["####.", "#...#", "#...#", "####.", "#....", "#....", "#...."],
    "Q": [".###.", "#...#", "#...#", "#...#", "#.#.#", "#..#.", ".##.#"],
    "R": ["####.", "#...#", "#...#", "####.", "#.#..", "#..#.", "#...#"],
    "S": [".####", "#....", "#....", ".###.", "....#", "....#", "####."],
    "T": ["#####", "..#..", "..#..", "..#..", "..#..", "..#..", "..#.."],
    "U": ["#...#", "#...#", "#...#", "#...#", "#...#", "#...#", ".###."],
    "V": ["#...#", "#...#", "#...#", "#...#", "#...#", ".#.#.", "..#.."],
    "W": ["#...#", "#...#", "#...#", "#.#.#", "#.#.#", "#.#.#", ".#.#."],
    "X": ["#...#", "#...#", ".#.#.", "..#..", ".#.#.", "#...#", "#...#"],
    "Y": ["#...#", "#...#", ".#.#.", "..#..", "..#..", "..#..", "..#.."],
    "Z": ["#####", "....#", "...#.", "..#..", ".#...", "#....", "#####"],
    "0": [".###.", "#...#", "#..##", "#.#.#", "##..#", "#...#", ".###."],
    "1": ["..#..", ".##..", "..#..", "..#..", "..#..", "..#..", ".###."],
    "2": [".###.", "#...#", "....#", "...#.", "..#..", ".#...", "#####"],
    "3": ["####.", "....#", "....#", ".###.", "....#", "....#", "####."],
    "4": ["...#.", "..##.", ".#.#.", "#..#.", "#####", "...#.", "...#."],
    "5": ["#####", "#....", "####.", "....#", "....#", "#...#", ".###."],
    "6": ["..##.", ".#...", "#....", "####.", "#...#", "#...#", ".###."],
    "7": ["#####", "....#", "...#.", "..#..", ".#...", ".#...", ".#..."],
    "8": [".###.", "#...#", "#...#", ".###.", "#...#", "#...#", ".###."],
    "9": [".###.", "#...#", "#...#", ".####", "....#", "...#.", ".##.."],
    "-": [".....", ".....", ".....", "#####", ".....", ".....", "....."],
    ":": [".....", "..#..", "..#..", ".....", "..#..", "..#..", "....."],
    " ": [".....", ".....", ".....", ".....", ".....", ".....", "....."],
}


class Canvas:
    def __init__(self, width, height, rgb):
        self.width, self.height = width, height
        self.rows = [bytearray(bytes(rgb) * width) for _ in range(height)]

    def rect(self, x, y, w, h, rgb):
        x0, x1 = max(0, x), min(self.width, x + w)
        if x1 <= x0:
            return
        run = bytes(rgb) * (x1 - x0)
        for row in range(max(0, y), min(self.height, y + h)):
            self.rows[row][x0 * 3:x1 * 3] = run

    def frame(self, px, rgb):
        self.rect(0, 0, self.width, px, rgb)
        self.rect(0, self.height - px, self.width, px, rgb)
        self.rect(0, 0, px, self.height, rgb)
        self.rect(self.width - px, 0, px, self.height, rgb)

    def text(self, line, cy, scale, rgb):
        """Draw `line` centred on the row `cy`, each glyph cell scale*6 wide, shrunk to fit."""
        scale = min(scale, max(1, (self.width - 80) // (len(line) * 6)))
        width = len(line) * 6 * scale - scale
        x = (self.width - width) // 2
        y = cy - (7 * scale) // 2
        for ch in line:
            for gy, bits in enumerate(GLYPHS.get(ch, GLYPHS[" "])):
                for gx, bit in enumerate(bits):
                    if bit == "#":
                        self.rect(x + gx * scale, y + gy * scale, scale, scale, rgb)
            x += 6 * scale

    def png(self):
        raw = b"".join(b"\x00" + bytes(r) for r in self.rows)

        def chunk(tag, data):
            return struct.pack(">I", len(data)) + tag + data + struct.pack(">I", zlib.crc32(tag + data) & 0xFFFFFFFF)

        ihdr = struct.pack(">IIBBBBB", self.width, self.height, 8, 2, 0, 0, 0)
        return (b"\x89PNG\r\n\x1a\n" + chunk(b"IHDR", ihdr)
                + chunk(b"IDAT", zlib.compress(raw, 9)) + chunk(b"IEND", b""))


def card(width, height, rgb, title, subtitle):
    c = Canvas(width, height, rgb)
    c.frame(24, (255, 255, 255))
    short = min(width, height)
    c.text(title, height // 2 - short // 12, max(4, short // 70), (255, 255, 255))
    c.text(subtitle, height // 2 + short // 8, max(2, short // 160), (230, 237, 243))
    return c.png()


def backing(width, height, rgb, stripe):
    """A backing: diagonal bands, so it shows wherever content does not cover it."""
    c = Canvas(width, height, rgb)
    band = 90
    for row in range(height):
        for start in range(-height, width, band * 2):
            c.rect(start + row, row, band, 1, stripe)
    return c.png()


def video(width, height, rgb):
    """A short H.264 clip with a quiet tone, or None without ffmpeg."""
    colour = "0x%02X%02X%02X" % rgb
    with tempfile.TemporaryDirectory() as tmp:
        path = os.path.join(tmp, "clip.mp4")
        cmd = [
            "ffmpeg", "-y", "-loglevel", "error",
            "-f", "lavfi", "-i", f"color=c={colour}:s={width}x{height}:d={VIDEO_SECONDS}:r=30",
            "-f", "lavfi", "-i", f"sine=frequency=330:beep_factor=2:duration={VIDEO_SECONDS}",
            "-filter_complex",
            f"[0:v]drawbox=x='(mod(t,{VIDEO_SECONDS})/{VIDEO_SECONDS})*(iw-240)':y=(ih-240)/2:w=240:h=240:color=white:t=fill,"
            f"drawbox=x=0:y=ih-36:w='iw*t/{VIDEO_SECONDS}':h=36:color=white:t=fill[v];[1:a]volume=0.12[a]",
            "-map", "[v]", "-map", "[a]",
            "-c:v", "libx264", "-pix_fmt", "yuv420p", "-profile:v", "baseline", "-level", "4.0",
            "-c:a", "aac", "-b:a", "64k",
            "-movflags", "+faststart", "-map_metadata", "-1",
            "-fflags", "+bitexact", "-flags:v", "+bitexact", "-flags:a", "+bitexact",
            path,
        ]
        try:
            subprocess.run(cmd, check=True)
        except (OSError, subprocess.CalledProcessError):
            return None
        with open(path, "rb") as f:
            return f.read()


# --------------------------------------------------------------------------
# The show.
# --------------------------------------------------------------------------

BLUE, GREEN, PURPLE = (0x1F, 0x5F, 0xC8), (0x1F, 0x7A, 0x3E), (0x6E, 0x4B, 0xB8)
AMBER, RED, TEAL = (0xB0, 0x7A, 0x10), (0xB4, 0x1C, 0x28), (0x0F, 0x6E, 0x78)

# id: (name, kind, colour, portrait, landscape, display_duration)
#   portrait / landscape: "own" = a file made for that orientation,
#   "landscape" = the landscape file placed in this slot, None = an empty slot.
ITEMS = {
    101: ("Welcome", "image", BLUE, "own", "own", 6),
    102: ("Schedule", "image", GREEN, "own", "own", 6),
    103: ("Sponsors", "image", PURPLE, "landscape", "own", 6),
    104: ("Wayfinding", "image", AMBER, "own", None, 6),
    105: ("Safety notice", "image", RED, "own", "own", 10),
    106: ("Sizzle reel", "video", BLUE, "own", "own", None),
    107: ("Reception tonight", "image", TEAL, "own", "own", 6),
    120: ("Backing", "backing", (0x14, 0x1A, 0x22), "own", "own", None),
    121: ("Main hall backing", "backing", (0x10, 0x2A, 0x3A), "own", "own", None),
}

LANDSCAPE_PLAYLIST = [101, 102, 103, 104, 105, 106, 107, "board"]   # 104 has no landscape file
PORTRAIT_PLAYLIST = [101, 104, 103, 105, 106, 107, "board"]         # 103 is a landscape file here

SESSIONS = [  # (day, start, end, name)
    (0, "09:00", "10:00", "Opening keynote"),
    (0, "10:30", "11:30", "Designing for the room"),
    (0, "13:00", "14:00", "Signage that tells time"),
    (0, "15:30", "16:30", "Panel: the lobby as a medium"),
    (1, "09:00", "10:00", "Morning briefing"),
    (1, "10:30", "11:30", "Workshop: one engine, many screens"),
    (1, "13:00", "14:00", "Case studies"),
    (1, "15:30", "16:30", "Closing remarks"),
]


def build():
    if os.path.isdir(OUT):
        shutil.rmtree(OUT)
    os.makedirs(OUT)

    # ---- media: one file per orientation an item needs ----
    files = {}      # file id -> dict
    slots = {}      # item id -> (portrait file id, landscape file id)
    next_id = 201

    def add_file(data, ctype, codec, w, h, duration):
        nonlocal next_id
        digest = hashlib.sha256(data).hexdigest()
        ext = {"image/png": "png", "video/mp4": "mp4"}[ctype]
        # Names are unique and immutable, minted from the bytes: new bytes, new name (§7.1).
        name = f"{uuid.uuid5(NAMES, digest)}.{ext}"
        with open(os.path.join(OUT, name), "wb") as f:
            f.write(data)
        fid = next_id
        next_id += 1
        files[fid] = dict(name=name, ctype=ctype, codec=codec, w=w, h=h, duration=duration,
                          size=len(data), hash="sha256:" + digest)
        return fid

    for item_id, (name, kind, rgb, portrait, landscape, _dwell) in ITEMS.items():
        made = {}
        for orient, (w, h) in (("landscape", (1920, 1080)), ("portrait", (1080, 1920))):
            wanted = landscape if orient == "landscape" else portrait
            if wanted != "own":
                continue
            label = f"{orient.upper()} FILE {w}X{h}"
            if kind == "image":
                made[orient] = add_file(card(w, h, rgb, name.upper(), label), "image/png", "PNG", w, h, None)
            elif kind == "backing":
                shade = tuple(min(255, c + 14) for c in rgb)
                made[orient] = add_file(backing(w, h, rgb, shade), "image/png", "PNG", w, h, None)
            else:
                data = video(w, h, rgb)
                if data is None:
                    print(f"  ! ffmpeg unavailable: {name} ({orient}) is left out")
                    continue
                made[orient] = add_file(data, "video/mp4", "H.264", w, h, float(VIDEO_SECONDS))
        p = made.get("portrait") if portrait == "own" else made.get("landscape") if portrait == "landscape" else None
        l = made.get("landscape") if landscape == "own" else None
        if p is None and l is None:
            continue
        slots[item_id] = (p, l)

    day_windows = [day_window(d) for d in DAYS]

    def seed(db, kind, item_ids):
        for table in (PROJECT_TABLES if kind == "project" else SURFACE_TABLES):
            db.execute(DDL[table])
        db.execute("INSERT INTO cartridge_meta VALUES (?,?,?,?,?,?,?)",
                   (kind, FORMAT_VERSION, SHOW, SURFACE if kind == "surface" else None, 1, TZ, GENERATED_AT))
        for n, (d, (start, end)) in enumerate(zip(DAYS, day_windows), 1):
            db.execute("INSERT INTO project_days VALUES (?,?,?,?,?,?)", (n, d, start, end, GENERATED_AT, GENERATED_AT))
        wanted_files = sorted({f for i in item_ids for f in slots[i] if f is not None})
        for fid in wanted_files:
            f = files[fid]
            db.execute("INSERT INTO media_file VALUES (?,?,?,?,?,?,?,?,?,?)",
                       (fid, f["ctype"], f["codec"], f["w"], f["h"],
                        "portrait" if f["h"] > f["w"] else "landscape", round(f["w"] / f["h"], 4),
                        f["duration"], GENERATED_AT, GENERATED_AT))
            db.execute("INSERT INTO media_manifest VALUES (?,?,?,?,?)",
                       (fid, f["name"], f["hash"], f["size"], f["ctype"]))
            db.execute("INSERT INTO media_file_variant VALUES (?,?,'original',?,?,?,?,?,?,?,?,?)",
                       (fid, fid, f["name"], f["ctype"], f["codec"], f["w"], f["h"], f["size"], f["hash"],
                        GENERATED_AT, GENERATED_AT))
        for i in item_ids:
            name, kind_, _rgb, _p, _l, dwell = ITEMS[i]
            p, l = slots[i]
            db.execute("INSERT INTO media_item VALUES (?,?,?,?,?,NULL,?,?)",
                       (i, name, p, l, dwell, GENERATED_AT, GENERATED_AT))

    def finish(db, path):
        db.commit()
        db.execute("PRAGMA foreign_keys = ON")
        bad = db.execute("PRAGMA foreign_key_check").fetchall()
        if bad:
            raise SystemExit(f"{path} is not internally consistent: {bad}")
        db.execute("VACUUM")
        db.close()

    # ---------------------------------------------------------------- project.db
    # The Show's identity, days and wallpaper. Backing and style ride in the
    # surface cartridge, so their pointers are NULL here (§3.2).
    path = os.path.join(OUT, "project.db")
    db = sqlite3.connect(path)
    seed(db, "project", [101])
    db.execute("INSERT INTO project VALUES (1, ?, 'Demo Show', ?, ?, 101, NULL, NULL, NULL, NULL, ?, ?)",
               (str(uuid.uuid5(NAMES, SHOW)), SHOW, TZ, GENERATED_AT, GENERATED_AT))
    finish(db, path)

    # --------------------------------------------------------------- DEMO1.db
    path = os.path.join(OUT, f"{SURFACE}.db")
    db = sqlite3.connect(path)
    seed(db, "surface", list(slots))
    # Wallpapers are NULL here (they live in project.db); the default backing is not.
    db.execute("INSERT INTO project VALUES (1, ?, 'Demo Show', ?, ?, NULL, NULL, 120, NULL, NULL, ?, ?)",
               (str(uuid.uuid5(NAMES, SHOW)), SHOW, TZ, GENERATED_AT, GENERATED_AT))
    db.execute("INSERT INTO surface_config VALUES (1, 'Demo', ?, 1, ?, ?, ?)",
               (SURFACE, GENERATED_AT, GENERATED_AT, GENERATED_AT))
    # Two installations of one config: a Surface picks one and adopts its orientation (§6).
    db.execute("INSERT INTO surface_location VALUES (1, 1, 'DEMO1-A', 'landscape', 'Main hall — north wall', ?, ?)",
               (GENERATED_AT, GENERATED_AT))
    db.execute("INSERT INTO surface_location VALUES (2, 1, 'DEMO1-B', 'portrait', 'Main hall — pillar', ?, ?)",
               (GENERATED_AT, GENERATED_AT))

    # The session board and its sessions.
    db.execute("INSERT INTO session_set (id, name, render_modes, duration, backing_item_id, created, updated)"
               " VALUES (1, 'Main Hall', '[\"simple\"]', 8, 121, ?, ?)", (GENERATED_AT, GENERATED_AT))
    for n, (d, start, end, title) in enumerate(SESSIONS, 1):
        db.execute("INSERT INTO session VALUES (?,?,NULL,'[]','[]',NULL,NULL,NULL,?,?)",
                   (n, title, GENERATED_AT, GENERATED_AT))
        db.execute("INSERT INTO session_set_entry VALUES (?,1,?,NULL,?,?,NULL,'Main Hall',?,?)",
                   (n, n, ms(f"{DAYS[d]} {start}:00"), ms(f"{DAYS[d]} {end}:00"), GENERATED_AT, GENERATED_AT))

    db.execute("INSERT INTO playlist VALUES (1, 'Landscape rotation', ?, ?)", (GENERATED_AT, GENERATED_AT))
    db.execute("INSERT INTO playlist VALUES (2, 'Portrait rotation', ?, ?)", (GENERATED_AT, GENERATED_AT))

    entries = []   # (entry id, playlist, item or "board")
    eid = 1
    for playlist, items in ((1, LANDSCAPE_PLAYLIST), (2, PORTRAIT_PLAYLIST)):
        for position, item in enumerate(items, 1):
            if item != "board" and item not in slots:
                continue   # no ffmpeg: the video item is absent
            if item == "board":
                db.execute("INSERT INTO playlist_entry VALUES (?,?,?,'session_set',NULL,1,NULL,NULL,NULL,NULL,?,?)",
                           (eid, playlist, position, GENERATED_AT, GENERATED_AT))
            else:
                # The landscape Sizzle reel is trimmed to 1 s - 5 s of its 6 s (§5.8).
                trim = (1.0, 5.0) if item == 106 else (None, None)
                db.execute("INSERT INTO playlist_entry VALUES (?,?,?,'media_item',?,NULL,NULL,NULL,?,?,?,?)",
                           (eid, playlist, position, item, trim[0], trim[1], GENERATED_AT, GENERATED_AT))
            entries.append((eid, playlist, item))
            eid += 1

    # The schedule: each lane runs its own playlist (§5.2), and from 18:00 on
    # Day 2 both lanes are an authored blank.
    sid = 1
    for slot, playlist in (("landscape", 1), ("portrait", 2)):
        db.execute("INSERT INTO surface_schedule_entry VALUES (?,1,?,?,?,NULL,NULL,?,?)",
                   (sid, slot, day_windows[0][0], playlist, GENERATED_AT, GENERATED_AT))
        sid += 1
        db.execute("INSERT INTO surface_schedule_entry VALUES (?,1,?,?,NULL,NULL,NULL,?,?)",
                   (sid, slot, ms(f"{DAYS[1]} 18:00:00"), GENERATED_AT, GENERATED_AT))
        sid += 1

    did = 1

    def directive(entry, kind, when, on):
        nonlocal did
        db.execute("INSERT INTO directive VALUES (?,?,?,?,?,?,?,?)",
                   (did, entry, kind, when, on, TZ, GENERATED_AT, GENERATED_AT))
        did += 1

    for entry, _playlist, item in entries:
        if item == 105:
            # The safety notice is takeover only, on Day 1: ON 12:00, OFF 14:00.
            directive(entry, "takeover", ms(f"{DAYS[0]} 12:00:00"), 1)
            directive(entry, "takeover", ms(f"{DAYS[0]} 14:00:00"), 0)
        elif item == 107:
            # Reception turns on at 17:00 on Day 1 and is never turned off. Day
            # scoping keeps that directive in Day 1: on Day 2 it is not on.
            directive(entry, "standard", ms(f"{DAYS[0]} 17:00:00"), 1)
        else:
            # Everything else is on from the start of each day. A directive only
            # governs within its own day, so each day gets its own.
            for start, _end in day_windows:
                directive(entry, "standard", start, 1)

    finish(db, path)

    print(f"{SHOW}/")
    for name in sorted(os.listdir(OUT)):
        print(f"  {name:44} {os.path.getsize(os.path.join(OUT, name)):>8} bytes")


if __name__ == "__main__":
    build()
