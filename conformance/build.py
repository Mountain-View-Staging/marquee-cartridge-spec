#!/usr/bin/env python3
"""
Marquee Conformance Suite — fixture cartridge builder.

Builds every cartridge in cartridges/ from the definitions below. No dependencies
beyond python3 (3.9+, for zoneinfo). Run from this folder:

    python3 build.py

The data is fictional: show SHOW26, surface LOBBY3, venue America/Los_Angeles,
Day 1 = 2026-09-15. There are no media bytes — engines never read them — so the
manifest's hashes are derived from the file names.

IDs are systematic so expected traces are easy to read:
  playlist entry id  = item id = position (1, 2, 3 …; playlist B uses 11, 12)
  portrait file id   = 100 + item id
  landscape file id  = 200 + item id
"""
import hashlib, os, sqlite3
from datetime import datetime
from zoneinfo import ZoneInfo

TZ = "America/Los_Angeles"
Z = ZoneInfo(TZ)
HERE = os.path.dirname(os.path.abspath(__file__))
OUT = os.path.join(HERE, "cartridges")
NOW = 1789000000000  # fixed created/updated stamp, so rebuilds are byte-stable in content

DDL = """
CREATE TABLE cartridge_meta (
  cartridge_kind     TEXT    NOT NULL,   -- 'project' | 'surface'
  format_version     TEXT    NOT NULL,   -- e.g. '25.0.1'
  project_code       TEXT    NOT NULL,   -- the show code; roots the media keyspace
  surface_id         TEXT,               -- the surface code; NULL in project.db
  published_revision INTEGER NOT NULL,   -- monotonic per artifact
  timezone           TEXT    NOT NULL,   -- IANA venue timezone
  generated_at       INTEGER NOT NULL    -- Unix ms the artifact was produced
);

CREATE TABLE media_manifest (
  media_file_id         INTEGER NOT NULL UNIQUE REFERENCES media_file(id),
  deliverable_file_name TEXT    NOT NULL,   -- flat object key, §7.1
  content_hash          TEXT    NOT NULL,   -- 'sha256:…' of these bytes
  file_size             INTEGER NOT NULL,   -- bytes
  content_type          TEXT    NOT NULL
);

CREATE TABLE project (
  id                        INTEGER PRIMARY KEY,
  cloud_uid                 TEXT    NOT NULL,
  name                      TEXT    NOT NULL,
  project_code              TEXT    NOT NULL,
  timezone                  TEXT    NOT NULL,
  show_wallpaper_item_id    INTEGER REFERENCES media_item(id),
  desktop_wallpaper_item_id INTEGER REFERENCES media_item(id),
  backing_item_id           INTEGER REFERENCES media_item(id),   -- default backing, §5.10
  brand_style               TEXT,     -- style address 'company/style/version', §9
  brand_style_item_id       INTEGER REFERENCES media_item(id),   -- the style book file, §9
  created                   INTEGER NOT NULL,
  updated                   INTEGER NOT NULL
);

CREATE TABLE project_days (
  id         INTEGER PRIMARY KEY,
  day        TEXT    NOT NULL UNIQUE,   -- 'YYYY-MM-DD', venue-local
  start_time INTEGER NOT NULL,          -- Unix ms, venue-local 00:00:00.000
  end_time   INTEGER NOT NULL,          -- Unix ms, venue-local 23:59:59.999
  created    INTEGER NOT NULL,
  updated    INTEGER NOT NULL
);

CREATE TABLE surface_config (
  id                 INTEGER PRIMARY KEY,
  name               TEXT    NOT NULL,
  surface_id         TEXT    NOT NULL,   -- the surface code
  published_revision INTEGER NOT NULL,
  published_at       INTEGER NOT NULL,
  created            INTEGER NOT NULL,
  updated            INTEGER NOT NULL
);

CREATE TABLE surface_location (
  id          INTEGER PRIMARY KEY,
  config_id   INTEGER NOT NULL REFERENCES surface_config(id),
  location_id TEXT    NOT NULL UNIQUE,   -- globally unique real-world id
  orientation TEXT    NOT NULL,          -- 'portrait' | 'landscape' (the mount)
  label       TEXT,
  created     INTEGER NOT NULL,
  updated     INTEGER NOT NULL
);

CREATE TABLE surface_schedule_entry (
  id                 INTEGER PRIMARY KEY,
  config_id          INTEGER NOT NULL REFERENCES surface_config(id),
  slot               TEXT    NOT NULL,   -- 'portrait' | 'landscape' | 'demo_station'
  timestamp          INTEGER NOT NULL,   -- most-recent <= now wins, per slot
  playlist_id        INTEGER REFERENCES playlist(id),     -- NULL on demo_station entries
  background_item_id INTEGER REFERENCES media_item(id),   -- demo branding (behind)
  overlay_item_id    INTEGER REFERENCES media_item(id),   -- demo branding (front)
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
);

CREATE TABLE playlist (
  id              INTEGER PRIMARY KEY,
  name            TEXT    NOT NULL,
  created         INTEGER NOT NULL,
  updated         INTEGER NOT NULL
);

CREATE TABLE playlist_entry (
  id                   INTEGER PRIMARY KEY,
  playlist_id          INTEGER NOT NULL REFERENCES playlist(id),
  position             INTEGER NOT NULL,                  -- authored order
  resource_type        TEXT    NOT NULL,                  -- 'media_item' | 'session_set'
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
);

CREATE TABLE directive (
  id        INTEGER PRIMARY KEY,
  entry_id  INTEGER NOT NULL REFERENCES playlist_entry(id),
  type      TEXT    NOT NULL,   -- 'standard' | 'takeover'
  timestamp INTEGER NOT NULL,
  on_screen INTEGER NOT NULL,
  timezone  TEXT,               -- authoring context only; never evaluated
  created   INTEGER NOT NULL,
  updated   INTEGER NOT NULL
);

CREATE TABLE media_item (
  id                INTEGER PRIMARY KEY,
  name              TEXT    NOT NULL,
  portrait_file_id  INTEGER REFERENCES media_file(id),
  landscape_file_id INTEGER REFERENCES media_file(id),
  display_duration  REAL,                                 -- seconds, stills
  brand_member      TEXT,                                 -- style address, §9; NULL = not brand
  created           INTEGER NOT NULL,
  updated           INTEGER NOT NULL,
  CHECK (portrait_file_id IS NOT NULL OR landscape_file_id IS NOT NULL)
);

CREATE TABLE media_file (
  id                 INTEGER PRIMARY KEY,
  content_type       TEXT    NOT NULL,   -- MIME of the imported file
  codec              TEXT,               -- what the imported file needs to decode
  width              INTEGER,
  height             INTEGER,
  orientation        TEXT,               -- advisory
  aspect_ratio       REAL,               -- advisory
  intrinsic_duration REAL,               -- seconds, video
  created            INTEGER NOT NULL,
  updated            INTEGER NOT NULL
);

CREATE TABLE session (
  id          INTEGER PRIMARY KEY,
  name        TEXT    NOT NULL,
  abstract    TEXT,
  presenters  TEXT,               -- JSON array
  attributes  TEXT,               -- JSON array
  source_id   TEXT,
  source_type TEXT,
  source_name TEXT,
  created     INTEGER NOT NULL,
  updated     INTEGER NOT NULL
);

CREATE TABLE session_set (
  id                INTEGER PRIMARY KEY,
  name              TEXT    NOT NULL,
  render_modes      TEXT    NOT NULL DEFAULT '["simple"]',   -- JSON array
  duration          REAL    NOT NULL DEFAULT 8,              -- seconds per board page
  backing_item_id   INTEGER REFERENCES media_item(id),
  logo_item_id      INTEGER REFERENCES media_item(id),
  schedule_template TEXT,               -- JSON diff vs the Surface baseline; NULL = baseline
  source_id         TEXT,
  source_name       TEXT,
  brand_style         TEXT,                               -- overrides the project's, §9
  brand_style_item_id INTEGER REFERENCES media_item(id),  -- overrides the project's, §9
  created           INTEGER NOT NULL,
  updated           INTEGER NOT NULL
);

CREATE TABLE session_set_entry (
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
);

CREATE TABLE media_file_variant (
  id            INTEGER PRIMARY KEY,
  media_file_id INTEGER NOT NULL REFERENCES media_file(id),
  kind          TEXT    NOT NULL,   -- 'original' | 'optimized' | 'webOptimized' | 'wifiOptimized' | …
  file_name     TEXT    NOT NULL,   -- flat object key, §7.1
  content_type  TEXT    NOT NULL,
  codec         TEXT,               -- required for video
  width         INTEGER,
  height        INTEGER,
  file_size     INTEGER NOT NULL,
  content_hash  TEXT    NOT NULL,   -- 'sha256:…' of THESE bytes
  created       INTEGER NOT NULL,
  updated       INTEGER NOT NULL
);

"""

def ms(local):
    """'2026-09-15 08:00:00' in the venue timezone -> Unix ms."""
    return int(datetime.strptime(local, "%Y-%m-%d %H:%M:%S").replace(tzinfo=Z).timestamp() * 1000)

def day(d):
    return (d, ms(d + " 00:00:00"), ms(d + " 23:59:59") + 999)

# ── cartridge model ────────────────────────────────────────────────────────────

def still(i, seconds=10, portrait=True, landscape=True, portrait_file=None):
    return dict(id=i, kind="still", seconds=seconds, portrait=portrait, landscape=landscape,
                portrait_file=portrait_file)

def video(i, seconds=12):
    return dict(id=i, kind="video", seconds=seconds, portrait=True, landscape=True, portrait_file=None)

def base(**over):
    c = dict(
        days=[day("2026-09-15")],
        items=[still(1), still(2), still(3), still(4)],
        playlists={1: [1, 2, 3, 4]},
        schedule=[("portrait", "2026-09-15 00:00:00", 1), ("landscape", "2026-09-15 00:00:00", 1)],
        directives=[(e, "standard", "2026-09-15 08:00:00", 1) for e in (1, 2, 3, 4)]
                   + [(2, "takeover", "2026-09-15 11:30:00", 1), (2, "takeover", "2026-09-15 12:30:00", 0)],
        session_sets=[],
        project_backing=None,
    )
    c.update(over)
    return c

def std(entries, when="2026-09-15 08:00:00"):
    return [(e, "standard", when, 1) for e in entries]

short_takeover = std((1, 2, 3, 4)) + [(2, "takeover", "2026-09-15 11:30:00", 1),
                                      (2, "takeover", "2026-09-15 11:30:24", 0)]

CARTRIDGES = {
    # MCS-01, 02, 07, 08, 09, 14, 16, 17
    "base": base(),
    # MCS-03
    "short-takeover": base(directives=short_takeover),
    # MCS-04
    "e3-off": base(directives=base()["directives"] + [(3, "standard", "2026-09-15 08:00:25", 0)]),
    # MCS-05
    "e3-off-during-takeover": base(directives=short_takeover + [(3, "standard", "2026-09-15 11:30:05", 0)]),
    # MCS-06
    "two-takeovers": base(directives=base()["directives"] + [(4, "takeover", "2026-09-15 11:30:00", 1),
                                                             (4, "takeover", "2026-09-15 12:30:00", 0)]),
    # MCS-10
    "board": base(
        items=[still(1), still(3)],
        session_sets=[dict(id=1, duration=8)],
        playlists={1: [1, ("board", 1), 3]},
        directives=std((1, 2)) + [(3, "takeover", "2026-09-15 08:00:20", 1),
                                  (3, "takeover", "2026-09-15 08:00:25", 0)]),
    # MCS-11
    "video": base(items=[video(1), video(2), still(3), video(4)], directives=std((1, 2, 3, 4))),
    # MCS-12
    "schedule-change": base(
        items=[still(1), still(2), still(3), still(4), still(11), still(12)],
        playlists={1: [1, 2, 3, 4], 2: [11, 12]},
        schedule=[("portrait", "2026-09-15 00:00:00", 1), ("portrait", "2026-09-15 08:00:25", 2)],
        directives=std((1, 2, 3, 4, 11, 12))),
    # MCS-13
    "two-days": base(
        days=[day("2026-09-15"), day("2026-09-16")],
        items=[still(1), still(2)],
        playlists={1: [1, 2]},
        directives=std((1, 2)) + std((1, 2), "2026-09-16 08:00:00")
                   + [(2, "takeover", "2026-09-15 20:00:00", 1)]),
    # MCS-15
    "orientation": base(
        items=[still(1, portrait=False), still(2, portrait_file=202), still(3)],
        playlists={1: [1, 2, 3]},
        directives=std((1, 2, 3))),
    # MCS-18
    "late-callback": base(
        items=[video(1), still(2), still(3)],
        playlists={1: [1, 2, 3]},
        directives=std((1, 2)) + [(3, "takeover", "2026-09-15 08:00:05", 1)]),
    # MCS-19
    "boundaries": base(
        schedule=[("portrait", "2026-09-15 00:00:00", 1), ("portrait", "2026-09-15 08:00:15", 1),
                  ("portrait", "2026-09-15 08:00:35", None)],
        directives=std((1, 2, 3, 4))),
}

# ── writer ─────────────────────────────────────────────────────────────────────

def h(name):
    return "sha256:" + hashlib.sha256(name.encode()).hexdigest()

def build(name, c):
    path = os.path.join(OUT, name + ".db")
    if os.path.exists(path):
        os.remove(path)
    db = sqlite3.connect(path)
    db.executescript(DDL)
    x = db.execute
    days = c["days"]
    x("INSERT INTO cartridge_meta VALUES ('surface','25.0.1','SHOW26','LOBBY3',1,?,?)", (TZ, NOW))
    for n, (d, s, e) in enumerate(days, 1):
        x("INSERT INTO project_days VALUES (?,?,?,?,?,?)", (n, d, s, e, NOW, NOW))
    x("INSERT INTO surface_config VALUES (1,'Lobby 3','LOBBY3',1,?,?,?)", (NOW, NOW, NOW))
    x("INSERT INTO surface_location VALUES (1,1,'LOBBY3-A','portrait','Lobby 3 — north wall',?,?)", (NOW, NOW))

    files = {}
    for it in c["items"]:
        i = it["id"]
        pf = it["portrait_file"] or (100 + i if it["portrait"] else None)
        lf = 200 + i if it["landscape"] or it["portrait_file"] else None
        for fid, (w, hgt) in ((pf, (1080, 1920)), (lf, (1920, 1080))):
            if fid is None or fid in files:
                continue
            if fid >= 200:
                w, hgt = 1920, 1080
            files[fid] = (it["kind"], w, hgt, it["seconds"])
        x("INSERT INTO media_item VALUES (?,?,?,?,?,NULL,?,?)",
          (i, f"Item {i}", pf, lf, it["seconds"] if it["kind"] == "still" else None, NOW, NOW))
    for fid, (kind, w, hgt, secs) in sorted(files.items()):
        is_video = kind == "video"
        ctype, codec = ("video/mp4", "H.264") if is_video else ("image/png", "PNG")
        ext = "mp4" if is_video else "png"
        fname = f"file-{fid}.{ext}"
        x("INSERT INTO media_file VALUES (?,?,?,?,?,?,?,?,?,?)",
          (fid, ctype, codec, w, hgt, "portrait" if hgt > w else "landscape", w / hgt,
           float(secs) if is_video else None, NOW, NOW))
        x("INSERT INTO media_manifest VALUES (?,?,?,?,?)", (fid, fname, h(fname), 1024, ctype))
        x("INSERT INTO media_file_variant VALUES (?,?,'original',?,?,?,?,?,?,?,?,?)",
          (fid, fid, fname, ctype, codec, w, hgt, 1024, h(fname), NOW, NOW))

    for s in c["session_sets"]:
        x("INSERT INTO session_set (id,name,render_modes,duration,created,updated) VALUES (?,?,'[\"simple\"]',?,?,?)",
          (s["id"], f"Room {s['id']}", s["duration"], NOW, NOW))
        for k in range(1, 4):
            x("INSERT INTO session VALUES (?,?,NULL,'[]','[]',NULL,NULL,NULL,?,?)",
              (k, f"Session {k}", NOW, NOW))
            x("INSERT INTO session_set_entry VALUES (?,?,?,NULL,?,?,NULL,?,?,?)",
              (k, s["id"], k, ms(f"2026-09-15 {8 + k:02d}:00:00"), ms(f"2026-09-15 {8 + k:02d}:45:00"),
               f"Room {s['id']}", NOW, NOW))

    x("INSERT INTO project VALUES (1,'00000000-0000-4000-8000-000000000026','Show 26','SHOW26',?,NULL,NULL,?,NULL,NULL,?,?)",
      (TZ, c["project_backing"], NOW, NOW))

    for pid, entries in c["playlists"].items():
        x("INSERT INTO playlist VALUES (?,?,?,?)", (pid, f"Playlist {chr(64 + pid)}", NOW, NOW))
        for pos, e in enumerate(entries, 1):
            if isinstance(e, tuple):  # ("board", session_set_id); entry id = position
                x("INSERT INTO playlist_entry VALUES (?,?,?,'session_set',NULL,?,NULL,NULL,NULL,NULL,?,?)",
                  (pos, pid, pos, e[1], NOW, NOW))
            else:
                x("INSERT INTO playlist_entry VALUES (?,?,?,'media_item',?,NULL,NULL,NULL,NULL,NULL,?,?)",
                  (e, pid, pos, e, NOW, NOW))

    for n, (slot, when, pid) in enumerate(c["schedule"], 1):
        x("INSERT INTO surface_schedule_entry VALUES (?,1,?,?,?,NULL,NULL,?,?)", (n, slot, ms(when), pid, NOW, NOW))
    for n, (entry, typ, when, on) in enumerate(c["directives"], 1):
        x("INSERT INTO directive VALUES (?,?,?,?,?,?,?,?)", (n, entry, typ, ms(when), on, TZ, NOW, NOW))

    db.commit()
    db.execute("PRAGMA foreign_keys = ON")
    bad = db.execute("PRAGMA foreign_key_check").fetchall()
    assert not bad, (name, bad)
    db.execute("VACUUM")
    db.close()

if __name__ == "__main__":
    os.makedirs(OUT, exist_ok=True)
    for name, c in CARTRIDGES.items():
        build(name, c)
        print("built", name)
