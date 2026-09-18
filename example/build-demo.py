#!/usr/bin/env python3
"""
Builds the demo show served from this repository's GitHub Pages site.

Everything here is REAL: the DDL is the cartridge schema verbatim, the two .db
files are ordinary SQLite databases produced the way a publisher produces them,
and the media are real PNGs listed in a real media_manifest. The browser client
in index.html reads them with no special cases.

Run it from this directory:

    python3 build-demo.py

It rewrites SHOW26/ from scratch. Nothing else in the repository is touched.

The demo is deliberately small but it exercises the rules that are easy to get
wrong: per-slot schedule resolution, orientation fallback, day-scoped
directives, and takeover suppression.
"""

import os
import shutil
import sqlite3
import struct
import subprocess
import zlib

HERE = os.path.dirname(os.path.abspath(__file__))
SHOW = "SHOW26"
SCREEN = "DEMO1"
OUT = os.path.join(HERE, SHOW)

# Fixed show days so the artifact is byte-stable across rebuilds. The client
# projects the viewer's wall clock onto Day 1 (the spec's "synthetic time"), so
# the demo behaves sensibly whenever anyone opens it.
TZ = "America/Los_Angeles"
DAY1 = 1791270000000   # 2026-10-05 00:00:00 -07:00
DAY2 = 1791356400000   # 2026-10-06 00:00:00 -07:00
DAY_MS = 86_400_000
VIDEO_SECONDS = 6
GENERATED_AT = DAY1 - DAY_MS


# --------------------------------------------------------------------------
# PNG writing — no dependencies, so this script runs anywhere python3 does.
# --------------------------------------------------------------------------

def write_png(path, width, height, rgb, border=(255, 255, 255), border_px=24):
    """A solid rectangle with a contrasting border, as a real PNG."""
    rows = bytearray()
    for y in range(height):
        rows.append(0)  # filter type 0 for this scanline
        edge_y = y < border_px or y >= height - border_px
        for x in range(width):
            edge = edge_y or x < border_px or x >= width - border_px
            rows.extend(border if edge else rgb)

    def chunk(tag, data):
        return (struct.pack(">I", len(data)) + tag + data
                + struct.pack(">I", zlib.crc32(tag + data) & 0xFFFFFFFF))

    ihdr = struct.pack(">IIBBBBB", width, height, 8, 2, 0, 0, 0)  # 8-bit truecolour
    with open(path, "wb") as f:
        f.write(b"\x89PNG\r\n\x1a\n")
        f.write(chunk(b"IHDR", ihdr))
        f.write(chunk(b"IDAT", zlib.compress(bytes(rows), 9)))
        f.write(chunk(b"IEND", b""))
    return os.path.getsize(path)


def write_video(path, width, height, rgb):
    """A short H.264 clip via ffmpeg. Optional: if ffmpeg is missing the demo
    still builds, it just has no video item."""
    colour = "0x%02X%02X%02X" % rgb
    cmd = [
        "ffmpeg", "-y", "-loglevel", "error",
        "-f", "lavfi", "-i", f"color=c={colour}:s={width}x{height}:d={VIDEO_SECONDS}:r=30",
        "-vf", f"drawbox=x='(mod(t,{VIDEO_SECONDS})/{VIDEO_SECONDS})*(iw-240)':"
               "y=(ih-240)/2:w=240:h=240:color=white:t=fill",
        "-c:v", "libx264", "-pix_fmt", "yuv420p", "-profile:v", "baseline",
        "-level", "3.1", "-movflags", "+faststart", path,
    ]
    try:
        subprocess.run(cmd, check=True)
    except (OSError, subprocess.CalledProcessError):
        return None
    return os.path.getsize(path)


# --------------------------------------------------------------------------
# The cartridge schema, verbatim. Tables a cartridge does not carry are simply
# never created — that is what "the publisher drops them" means on disk.
# --------------------------------------------------------------------------

SHARED_DDL = """
CREATE TABLE grdb_migrations (identifier TEXT NOT NULL PRIMARY KEY);

CREATE TABLE project (
  id                        INTEGER PRIMARY KEY AUTOINCREMENT,
  cloud_uid                 TEXT    NOT NULL,
  name                      TEXT    NOT NULL,
  created                   INTEGER NOT NULL,
  updated                   INTEGER NOT NULL,
  retain_originals          INTEGER NOT NULL DEFAULT 1,
  timezone                  TEXT,
  project_code              TEXT,
  show_wallpaper_item_id    INTEGER REFERENCES media_item(id) ON DELETE RESTRICT,
  desktop_wallpaper_item_id INTEGER REFERENCES media_item(id) ON DELETE RESTRICT,
  edit_code_required        INTEGER NOT NULL DEFAULT 0
);

CREATE TABLE project_days (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  day        TEXT    NOT NULL UNIQUE,
  start_time INTEGER NOT NULL,
  end_time   INTEGER NOT NULL,
  created    INTEGER NOT NULL,
  updated    INTEGER NOT NULL
);

CREATE TABLE media_file (
  id                  INTEGER PRIMARY KEY AUTOINCREMENT,
  source_file_name    TEXT    NOT NULL UNIQUE,
  thumbnail_file_name TEXT,
  content_type        TEXT    NOT NULL,
  width               INTEGER,
  height              INTEGER,
  orientation         TEXT,
  aspect_ratio        REAL,
  intrinsic_duration  REAL,
  file_size           INTEGER,
  source_hash         TEXT,
  content_hash        TEXT,
  codec               TEXT,
  color_space         TEXT,
  was_converted       INTEGER NOT NULL DEFAULT 0,
  original_type       TEXT,
  original_file_name  TEXT,
  source_document     TEXT,
  source              TEXT,
  created             INTEGER NOT NULL,
  updated             INTEGER NOT NULL,
  optimized_file_name TEXT
);

CREATE TABLE media_item (
  id                INTEGER PRIMARY KEY AUTOINCREMENT,
  name              TEXT    NOT NULL,
  portrait_file_id  INTEGER REFERENCES media_file(id) ON DELETE RESTRICT,
  landscape_file_id INTEGER REFERENCES media_file(id) ON DELETE RESTRICT,
  display_duration  REAL,
  system_generated  INTEGER NOT NULL DEFAULT 0,
  audio_priority    TEXT,
  backing_item_id   INTEGER REFERENCES media_item(id) ON DELETE RESTRICT,
  overlay_item_id   INTEGER REFERENCES media_item(id) ON DELETE RESTRICT,
  archived          INTEGER NOT NULL DEFAULT 0,
  created           INTEGER NOT NULL,
  updated           INTEGER NOT NULL,
  CHECK (portrait_file_id IS NOT NULL OR landscape_file_id IS NOT NULL)
);

CREATE TABLE media_manifest (
  media_file_id INTEGER NOT NULL, deliverable_file_name TEXT NOT NULL,
  content_hash TEXT, file_size INTEGER, content_type TEXT NOT NULL
);
"""

SCREEN_DDL = """
CREATE TABLE cartridge_meta (
  screen_id TEXT, project_code TEXT, published_revision INTEGER NOT NULL,
  show_wallpaper_item_id INTEGER, desktop_wallpaper_item_id INTEGER,
  cloud_media_base_url TEXT, timezone TEXT,
  generated_at INTEGER NOT NULL
);

CREATE TABLE screen_config (
  id                 INTEGER PRIMARY KEY AUTOINCREMENT,
  name               TEXT    NOT NULL,
  revision           INTEGER NOT NULL DEFAULT 0,
  archived           INTEGER NOT NULL DEFAULT 0,
  created            INTEGER NOT NULL,
  updated            INTEGER NOT NULL,
  screen_id          TEXT,
  published_revision INTEGER,
  published_at       INTEGER
);

CREATE TABLE screen_location (
  id                   INTEGER PRIMARY KEY AUTOINCREMENT,
  config_id            INTEGER NOT NULL REFERENCES screen_config(id) ON DELETE CASCADE,
  location_id          TEXT    NOT NULL UNIQUE,
  orientation          TEXT    NOT NULL,
  label                TEXT,
  last_checked_at      INTEGER,
  last_pulled_revision INTEGER,
  created              INTEGER NOT NULL,
  updated              INTEGER NOT NULL
);

CREATE TABLE playlist (
  id                INTEGER PRIMARY KEY AUTOINCREMENT,
  name              TEXT    NOT NULL,
  shuffle           INTEGER NOT NULL DEFAULT 0,
  is_seamless_video INTEGER NOT NULL DEFAULT 0,
  backing_item_id   INTEGER REFERENCES media_item(id) ON DELETE RESTRICT,
  overlay_item_id   INTEGER REFERENCES media_item(id) ON DELETE RESTRICT,
  archived          INTEGER NOT NULL DEFAULT 0,
  created           INTEGER NOT NULL,
  updated           INTEGER NOT NULL
);

CREATE TABLE screen_schedule_entry (
  id                 INTEGER PRIMARY KEY AUTOINCREMENT,
  config_id          INTEGER NOT NULL REFERENCES screen_config(id) ON DELETE CASCADE,
  slot               TEXT    NOT NULL,
  timestamp          INTEGER NOT NULL,
  playlist_id        INTEGER REFERENCES playlist(id)   ON DELETE RESTRICT,
  background_item_id INTEGER REFERENCES media_item(id) ON DELETE RESTRICT,
  overlay_item_id    INTEGER REFERENCES media_item(id) ON DELETE RESTRICT,
  created            INTEGER NOT NULL,
  updated            INTEGER NOT NULL,
  CHECK (
    ( slot IN ('portrait','landscape')
        AND background_item_id IS NULL AND overlay_item_id IS NULL )
    OR
    ( slot = 'demo_station'
        AND ( background_item_id IS NOT NULL OR overlay_item_id IS NULL ) )
  )
);

CREATE TABLE session (
  id INTEGER PRIMARY KEY AUTOINCREMENT, name TEXT NOT NULL, abstract TEXT,
  presenters TEXT, attributes TEXT, source_id TEXT, source_type TEXT,
  source_name TEXT, created INTEGER NOT NULL, updated INTEGER NOT NULL
);

CREATE TABLE session_set (
  id INTEGER PRIMARY KEY AUTOINCREMENT, name TEXT NOT NULL,
  render_modes TEXT NOT NULL DEFAULT '["simple"]', duration REAL NOT NULL DEFAULT 8,
  backing_item_id INTEGER REFERENCES media_item(id) ON DELETE RESTRICT,
  logo_item_id    INTEGER REFERENCES media_item(id) ON DELETE RESTRICT,
  schedule_template TEXT, source_id TEXT, source_name TEXT,
  created INTEGER NOT NULL, updated INTEGER NOT NULL
);

CREATE TABLE playlist_entry (
  id                   INTEGER PRIMARY KEY AUTOINCREMENT,
  playlist_id          INTEGER NOT NULL REFERENCES playlist(id) ON DELETE CASCADE,
  media_item_id        INTEGER REFERENCES media_item(id)  ON DELETE RESTRICT,
  session_set_id       INTEGER REFERENCES session_set(id) ON DELETE RESTRICT,
  position             INTEGER NOT NULL,
  created              INTEGER NOT NULL,
  updated              INTEGER NOT NULL,
  resource_type        TEXT    NOT NULL DEFAULT 'media_item',
  start_time_portrait  REAL,
  end_time_portrait    REAL,
  start_time_landscape REAL,
  end_time_landscape   REAL,
  loop_clip            INTEGER NOT NULL DEFAULT 0,
  pause_on_entry       INTEGER NOT NULL DEFAULT 0,
  pause_on_completion  INTEGER NOT NULL DEFAULT 0,
  disabled             INTEGER NOT NULL DEFAULT 0,
  CHECK (resource_type <> 'media_item'  OR media_item_id  IS NOT NULL),
  CHECK (resource_type <> 'session_set' OR session_set_id IS NOT NULL)
);

CREATE TABLE session_set_entry (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  session_set_id INTEGER NOT NULL REFERENCES session_set(id) ON DELETE CASCADE,
  session_id     INTEGER NOT NULL REFERENCES session(id)     ON DELETE RESTRICT,
  session_time_id TEXT, start_time INTEGER NOT NULL, end_time INTEGER NOT NULL,
  source_room_id TEXT, room_name TEXT,
  created INTEGER NOT NULL, updated INTEGER NOT NULL
);

CREATE TABLE directive (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  entry_id   INTEGER NOT NULL REFERENCES playlist_entry(id) ON DELETE CASCADE,
  type       TEXT    NOT NULL,
  timestamp  INTEGER NOT NULL,
  on_screen  INTEGER NOT NULL,
  timezone   TEXT,
  created    INTEGER NOT NULL,
  updated    INTEGER NOT NULL
);
"""

# id, name, colour, the file it gets in each orientation slot
ITEMS = [
    (101, "Welcome",        (0x1F, 0x6F, 0xEB), "both",           "image"),
    (102, "Schedule",       (0x23, 0x8B, 0x45), "both",           "image"),
    (103, "Sponsors",       (0x8A, 0x63, 0xD2), "landscape-only", "image"),
    (104, "Wayfinding",     (0xD2, 0x9A, 0x22), "portrait-only",  "image"),
    (105, "SAFETY NOTICE",  (0xCF, 0x22, 0x2E), "both",           "image"),
    (106, "Sizzle Reel",    (0x1F, 0x6F, 0xEB), "both",           "video"),
]


def build():
    if os.path.isdir(OUT):
        shutil.rmtree(OUT)
    os.makedirs(OUT)

    # ---- media: one file per orientation slot that an item actually uses ----
    files = []          # (file_id, name, w, h, orientation, size)
    next_file_id = 201
    item_slots = {}     # item_id -> (portrait_file_id, landscape_file_id)

    for item_id, name, rgb, coverage, kind in ITEMS:
        portrait_id = landscape_id = None
        ext = "mp4" if kind == "video" else "png"
        ctype = "video/mp4" if kind == "video" else "image/png"
        duration = float(VIDEO_SECONDS) if kind == "video" else None
        for orient, (w, h) in (("portrait", (1080, 1920)), ("landscape", (1920, 1080))):
            if coverage == "portrait-only" and orient != "portrait":
                continue
            if coverage == "landscape-only" and orient != "landscape":
                continue
            fn = f"{item_id}-{orient}.{ext}"
            path = os.path.join(OUT, fn)
            size = write_video(path, w, h, rgb) if kind == "video" else write_png(path, w, h, rgb)
            if size is None:
                print(f"  ! ffmpeg unavailable — skipping {fn}")
                continue
            files.append((next_file_id, fn, w, h, orient, size, ctype, duration))
            if orient == "portrait":
                portrait_id = next_file_id
            else:
                landscape_id = next_file_id
            next_file_id += 1
        if portrait_id is None and landscape_id is None:
            continue   # nothing generated (no ffmpeg) — the item is simply absent
        item_slots[item_id] = (portrait_id, landscape_id)

    def seed_shared(db, include_all_media):
        db.executescript(SHARED_DDL)
        db.execute("INSERT INTO grdb_migrations VALUES (?)", ("v1-baseline",))
        db.execute("INSERT INTO grdb_migrations VALUES (?)", ("v2-media-variants",))
        db.execute("INSERT INTO grdb_migrations VALUES (?)", ("v3-media-optimization",))
        db.execute("INSERT INTO grdb_migrations VALUES (?)", ("v4-entry-playback-states",))
        db.execute(
            "INSERT INTO project (id, cloud_uid, name, created, updated, timezone, project_code)"
            " VALUES (1, 'demo-show-26', 'Marquee Demo Show', ?, ?, ?, ?)",
            (GENERATED_AT, GENERATED_AT, TZ, SHOW))
        for n, (day, start) in enumerate([("2026-10-05", DAY1), ("2026-10-06", DAY2)], 1):
            db.execute(
                "INSERT INTO project_days (id, day, start_time, end_time, created, updated)"
                " VALUES (?,?,?,?,?,?)",
                (n, day, start, start + DAY_MS - 1, GENERATED_AT, GENERATED_AT))

        wanted = {f[0] for f in files} if include_all_media else set()
        for file_id, fn, w, h, orient, size, ctype, duration in files:
            if file_id not in wanted:
                continue
            db.execute(
                "INSERT INTO media_file (id, source_file_name, content_type, width, height,"
                " orientation, aspect_ratio, intrinsic_duration, file_size, created, updated)"
                " VALUES (?,?,?,?,?,?,?,?,?,?,?)",
                (file_id, fn, ctype, w, h, orient, round(w / h, 4), duration, size,
                 GENERATED_AT, GENERATED_AT))
            # file_size present, content_hash deliberately NULL: this demo is
            # shaped like a legacy publisher's output, so a client that refuses
            # hash-less media fails here exactly as it would in the field.
            db.execute(
                "INSERT INTO media_manifest VALUES (?,?,?,?,?)",
                (file_id, fn, None, size, ctype))
        for item_id, name, _rgb, _cov, _kind in ITEMS:
            if not include_all_media or item_id not in item_slots:
                continue
            p, l = item_slots[item_id]
            db.execute(
                "INSERT INTO media_item (id, name, portrait_file_id, landscape_file_id,"
                " display_duration, created, updated) VALUES (?,?,?,?,?,?,?)",
                (item_id, name, p, l, 8.0, GENERATED_AT, GENERATED_AT))

    # ---------------------------------------------------------------- project.db
    project_path = os.path.join(OUT, "project.db")
    db = sqlite3.connect(project_path)
    seed_shared(db, include_all_media=False)
    db.commit()
    db.execute("PRAGMA foreign_key_check").fetchall()
    db.close()

    # --------------------------------------------------------------- <SCREEN>.db
    screen_path = os.path.join(OUT, f"{SCREEN}.db")
    db = sqlite3.connect(screen_path)
    seed_shared(db, include_all_media=True)
    db.executescript(SCREEN_DDL)

    db.execute(
        "INSERT INTO cartridge_meta (screen_id, project_code, published_revision,"
        " cloud_media_base_url, timezone, generated_at) VALUES (?,?,?,?,?,?)",
        (SCREEN, SHOW, 1, None, TZ, GENERATED_AT))
    db.execute(
        "INSERT INTO screen_config (id, name, revision, created, updated, screen_id,"
        " published_revision, published_at) VALUES (1, 'Demo Screen', 1, ?, ?, ?, 1, ?)",
        (GENERATED_AT, GENERATED_AT, SCREEN, GENERATED_AT))
    # One location. Its orientation is what a client adopts at provisioning, and
    # it matches the slot the schedule below is built on — by construction, the
    # two cannot disagree.
    db.execute(
        "INSERT INTO screen_location (id, config_id, location_id, orientation, label,"
        " created, updated) VALUES (1, 1, ?, 'landscape', 'Demo Screen — main hall', ?, ?)",
        (SCREEN, GENERATED_AT, GENERATED_AT))

    for pid, name in [(1, "Landscape rotation"), (2, "Portrait rotation")]:
        db.execute(
            "INSERT INTO playlist (id, name, created, updated) VALUES (?,?,?,?)",
            (pid, name, GENERATED_AT, GENERATED_AT))

    # Both slots are scheduled, so flipping orientation in the client changes
    # which playlist resolves — the per-slot rule, made visible.
    for sid, slot, playlist in [(1, "landscape", 1), (2, "portrait", 2)]:
        db.execute(
            "INSERT INTO screen_schedule_entry (id, config_id, slot, timestamp, playlist_id,"
            " created, updated) VALUES (?,1,?,?,?,?,?)",
            (sid, slot, DAY1, playlist, GENERATED_AT, GENERATED_AT))

    # Note entry 8: Sponsors has a LANDSCAPE file only, and it is scheduled in the
    # PORTRAIT playlist. A client must fall back to the other orientation's file
    # rather than drop the entry (§5.6) — without a case like this, that branch
    # never runs and a client can ship without it.
    entries = [
        (1, 1, 101, 0), (2, 1, 102, 1), (3, 1, 103, 2), (4, 1, 105, 3),
        (5, 2, 101, 0), (6, 2, 104, 1), (7, 2, 105, 2), (8, 2, 103, 3),
        (9, 1, 106, 4), (10, 2, 106, 4),
    ]
    entries = [e for e in entries if e[2] in item_slots]
    for eid, playlist, item, position in entries:
        db.execute(
            "INSERT INTO playlist_entry (id, playlist_id, media_item_id, position,"
            " created, updated, resource_type) VALUES (?,?,?,?,?,?,'media_item')",
            (eid, playlist, item, position, GENERATED_AT, GENERATED_AT))

    # Directives. Every entry's standard directive is ON from the start of each
    # day — note the per-day repetition: a directive outside today's window does
    # not govern today, so an ON authored only on day 1 would leave day 2 empty.
    did = 1
    for eid, _playlist, item, _pos in entries:
        for day_start in (DAY1, DAY2):
            on = 0 if item == 105 else 1   # the safety notice starts OFF
            db.execute(
                "INSERT INTO directive (id, entry_id, type, timestamp, on_screen, timezone,"
                " created, updated) VALUES (?,?, 'standard', ?,?,?,?,?)",
                (did, eid, day_start, on, TZ, GENERATED_AT, GENERATED_AT))
            did += 1

    # The takeover: on day 1 only, from 12:00 to 14:00 local, entries 4 and 7
    # (the safety notice) take over their slot. While it is ON the standard
    # rotation is suppressed ENTIRELY — that is the rule worth seeing happen.
    for eid in (4, 7):
        for offset, on in ((12 * 3600_000, 1), (14 * 3600_000, 0)):
            db.execute(
                "INSERT INTO directive (id, entry_id, type, timestamp, on_screen, timezone,"
                " created, updated) VALUES (?,?, 'takeover', ?,?,?,?,?)",
                (did, eid, DAY1 + offset, on, TZ, GENERATED_AT, GENERATED_AT))
            did += 1

    db.commit()
    violations = db.execute("PRAGMA foreign_key_check").fetchall()
    if violations:
        raise SystemExit(f"cartridge is not internally consistent: {violations}")
    db.close()

    print(f"{SHOW}/")
    for name in sorted(os.listdir(OUT)):
        print(f"  {name:24} {os.path.getsize(os.path.join(OUT, name)):>8} bytes")


if __name__ == "__main__":
    build()
