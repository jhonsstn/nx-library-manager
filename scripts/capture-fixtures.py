#!/usr/bin/env python3
"""Capture legacy Swift/Python behaviour as JSON regression fixtures.

The Electron port must reproduce the Qt application's parsing, matching, version
and formatting output. This script runs the *original* Python implementation over
a fixed case set and writes the results to ``tests/fixtures/legacy/behavior.json``,
which the TypeScript unit tests then assert against.

The Qt ``ui.py`` module cannot be imported without PySide6, so the pure helper
functions it contains are extracted with ``ast`` and executed in isolation.
"""

from __future__ import annotations

import argparse
import ast
import json
import re
import sys
from dataclasses import dataclass
from pathlib import Path
from typing import Any, Callable

# Verbatim copy of the DDL executed by `switch_catalog/db.init_db` in the Qt
# application, used to snapshot the legacy schema the Electron build must open.
LEGACY_SCHEMA_SQL = """
CREATE TABLE IF NOT EXISTS games (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    display_title TEXT NOT NULL,
    cleaned_title TEXT NOT NULL UNIQUE,
    metadata_provider TEXT,
    metadata_provider_id TEXT,
    description TEXT,
    release_date TEXT,
    developer TEXT,
    publisher TEXT,
    genres TEXT,
    cover_image_path TEXT,
    cover_image_url TEXT,
    trailer_url TEXT,
    date_added TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
    last_scanned TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
    metadata_locked INTEGER NOT NULL DEFAULT 0,
    needs_review INTEGER NOT NULL DEFAULT 0,
    favorite INTEGER NOT NULL DEFAULT 0
);

CREATE TABLE IF NOT EXISTS game_files (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    game_id INTEGER NOT NULL REFERENCES games(id) ON DELETE CASCADE,
    file_path TEXT NOT NULL UNIQUE,
    file_name TEXT NOT NULL,
    file_extension TEXT NOT NULL,
    file_size INTEGER NOT NULL,
    modified_time REAL NOT NULL,
    file_type TEXT NOT NULL,
    is_base_game INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS updates (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    game_id INTEGER REFERENCES games(id) ON DELETE SET NULL,
    file_path TEXT NOT NULL UNIQUE,
    file_name TEXT NOT NULL,
    detected_version TEXT,
    file_size INTEGER NOT NULL,
    modified_time REAL NOT NULL,
    match_confidence REAL NOT NULL DEFAULT 0,
    manual_match INTEGER NOT NULL DEFAULT 0
);

CREATE TABLE IF NOT EXISTS install_jobs (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    game_id INTEGER REFERENCES games(id) ON DELETE SET NULL,
    source_path TEXT NOT NULL,
    destination_path TEXT,
    destination_folder TEXT NOT NULL,
    destination_label TEXT,
    file_name TEXT NOT NULL,
    file_size INTEGER NOT NULL DEFAULT 0,
    file_kind TEXT NOT NULL,
    detected_version TEXT,
    raw_version INTEGER NOT NULL DEFAULT 0,
    status TEXT NOT NULL,
    error TEXT,
    created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
    completed_at TEXT
);

CREATE TABLE IF NOT EXISTS screenshots (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    game_id INTEGER NOT NULL REFERENCES games(id) ON DELETE CASCADE,
    image_url TEXT NOT NULL,
    local_path TEXT,
    sort_order INTEGER NOT NULL DEFAULT 0,
    UNIQUE(game_id, image_url)
);

CREATE TABLE IF NOT EXISTS metadata_cache (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    provider TEXT NOT NULL,
    query TEXT NOT NULL,
    response_json TEXT NOT NULL,
    cached_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
    UNIQUE(provider, query)
);
"""

FILENAME_CASES = [
    "The Legend of Zelda - Breath of the Wild.nsp",
    "Super Mario Odyssey [0100000000010000][v0].nsp",
    "Super Mario Odyssey [0100000000010800][v65536].nsp",
    "Game Update v65536.nsp",
    "Some Game [DLC] v1.2.3.nsz",
    "Pokémon™ Scarlet – The Hidden Treasure of Area Zero.xci",
    "USA Zelda EUR Repack v0.nsp",
    "0100ABCDEF123456.nsp",
    "Mario Kart 8 Deluxe [v3.0.1] (USA).xci",
    "Untitled_game-update-v131072.nsp",
    "Dragon Ball Z - Kakarot v1.0.0.nsp",
    "Hades.nsz",
    "Hades [0100A3A0149EC800][v131072][UPD].nsp",
    "Animal Crossing New Horizons 2.0.6.nsp",
    "Splatoon 3 [DLC] Wave 1.nsp",
    "Metroid Dread (World) (En,Fr,De) [010093801237C000].nsz",
    "Xenoblade Chronicles 3 v2.1.0 [update].nsp",
    "Just Dance 2024 Edition.nsp",
    "Sonic Frontiers - Digital Deluxe.nsp",
    "NotAGame.txt",
]

MATCH_CASES = [
    ("Super Mario Odyssey [v65536].nsp", ["Super Mario Odyssey.nsp"]),
    ("Super Mario Odyssey [v65536].nsp", ["Super Mario Odyssey.nsp", "Super Mario 3D All-Stars.nsp"]),
    ("Some Game [DLC] v1.2.3.nsz", ["Some Game.nsp", "Other Game.nsz"]),
    ("Unknown Thing v131072.nsp", ["Hades.nsz"]),
    ("Hades [0100A3A0149EC800][v131072][UPD].nsp", ["Hades.nsz"]),
    ("Mario Kart 8 Deluxe v3.0.1.nsp", ["Mario Kart 8 Deluxe.nsp", "Mario Kart 8 Deluxe - Booster Course Pass.nsp"]),
    ("Zelda Update v1.0.0.nsp", ["The Legend of Zelda - Tears of the Kingdom.nsp", "Zelda.nsp"]),
    ("Animal Crossing New Horizons 2.0.6.nsp", ["Animal Crossing New Horizons.nsp"]),
    ("Splatoon 3 v1.0.0.nsp", ["Splatoon 3.nsp"]),
    ("TOTK Update.nsp", ["The Legend of Zelda - Tears of the Kingdom.nsp"]),
]

FUZZ_PAIRS = [
    ("super mario odyssey", "super mario odyssey"),
    ("super mario odyssey", "super mario odyssey 2"),
    ("super mario odyssey", "super mario galaxy"),
    ("zelda", "zelda"),
    ("", ""),
    ("a", ""),
    ("hades", "hades ii"),
    ("the legend of zelda - tears of the kingdom", "the legend of zelda - breath of the wild"),
    ("mario kart 8 deluxe", "mario kart 8 deluxe booster course pass"),
    ("splatoon 3", "splatooon 3"),
    ("xenoblade chronicles 3", "xenoblade chronicles 3"),
    ("pokemon scarlet", "pokemon violet"),
]

VERSIONS_JSON_SAMPLE = {
    "0100000000010000": {"0": "2017-03-03", "65536": "2017-05-01", "131072": "2018-01-01"},
    "0100A3A0149EC000": {"0": "2020-09-17", "131072": "2021-01-01"},
}

VERSIONS_TXT_SAMPLE = "\n".join(
    [
        "id|name|version",
        "0100000000010800|Super Mario Odyssey Update|131072",
        "0100000000010000|Super Mario Odyssey|65536",
        "0100A3A0149EC800|Hades Update|262144",
        "not-a-title-id|Ignored|1",
        "0100000000010800|Super Mario Odyssey Update|262144",
    ]
)

RANGE_CASES = [
    (1000, "bytes=0-99"),
    (1000, "bytes=100-"),
    (1000, "bytes=-100"),
    (1000, "bytes=0-0"),
    (1000, "bytes=999-1000"),
    (1000, "bytes=1000-1200"),
    (1000, "bytes=500-400"),
    (1000, "bytes=-0"),
    (1000, "bytes=0-"),
    (1000, "bytes="),
    (1000, "items=0-10"),
    (0, "bytes=0-10"),
    (1, "bytes=0-0"),
    (1, "bytes=1-2"),
    (2048, "bytes=2047-2047"),
]

TITLE_SIMILARITY_PAIRS = [
    ("Super Mario Odyssey", "Super Mario Odyssey"),
    ("Super Mario Odyssey", "Super Mario Odyssey 2"),
    ("The Legend of Zelda: Breath of the Wild", "The Legend of Zelda: Tears of the Kingdom"),
    ("Hades", "Hades II"),
    ("Pokémon Scarlet", "Pokemon Scarlet"),
    ("Splatoon 3", "SPLATOON 3"),
    ("Metroid Dread", "Metroid"),
    ("Animal Crossing: New Horizons", "Animal Crossing New Horizons"),
]

METADATA_TITLE_CASES = [
    "The Legend of Zelda\u2122: Breath of the Wild",
    "Pokémon Scarlet – The Hidden Treasure of Area Zero",
    "Super Mario Odyssey [0100000000010000]",
    "The Last of Us\u2122 Remastered",
    "Xenoblade Chronicles™ 3: Future Redeemed",
    "A Game: The Sequel",
    "An Apple: The Beginning",
]

UI_FUNCTION_NAMES = [
    "_detected_version_suffix",
    "_detected_raw_version",
    "_compact_dotted_version",
    "_update_file_group",
    "_format_bytes",
    "_install_size_text",
    "_path_is_install_destination",
    "_higher_res_image_url",
    "_youtube_player_url",
    "_youtube_embed_url",
    "_display_folder",
    "_metadata_ready",
]

BYTES_CASES = [0, 1, 512, 1023, 1024, 1536, 1048576, 5 * 1024**3, 1024**4 * 3]

IMAGE_URL_CASES = [
    "//images.igdb.com/igdb/image/upload/t_thumb/abc.jpg",
    "http://images.igdb.com/igdb/image/upload/t_thumb/abc.jpg",
    "https://images.igdb.com/igdb/image/upload/t_cover_big/abc.jpg",
    "https://images.igdb.com/igdb/image/upload/t_cover_big_2x/abc.jpg",
    "https://images.igdb.com/igdb/image/upload/t_screenshot_med/abc.jpg",
    "https://images.igdb.com/igdb/image/upload/t_720p/abc.jpg",
    "https://example.com/cover.png",
]

YOUTUBE_URL_CASES = [
    "https://www.youtube.com/watch?v=dQw4w9WgXcQ",
    "https://www.youtube.com/embed/dQw4w9WgXcQ",
    "https://youtu.be/dQw4w9WgXcQ",
    "https://youtu.be/dQw4w9WgXcQ?t=30",
    "https://example.com/video",
]


class _QUrl:
    """Minimal stand-in for `PySide6.QtCore.QUrl`, used only by `_youtube_embed_url`."""

    def __init__(self, value: str) -> None:
        self._value = value

    def query(self) -> str:
        _, _, query = self._value.partition("?")
        return query


@dataclass
class ExtractedHelpers:
    namespace: dict[str, Any]

    def __getitem__(self, name: str) -> Callable[..., Any]:
        return self.namespace[name]


def extract_pure_helpers(ui_path: Path, names: list[str], namespace: dict[str, Any]) -> ExtractedHelpers:
    """Compile selected top-level functions out of a module that needs Qt."""
    tree = ast.parse(ui_path.read_text(encoding="utf-8"))
    wanted = []
    for node in tree.body:
        if isinstance(node, ast.FunctionDef) and node.name in names:
            wanted.append(node)
    module = ast.Module(body=wanted, type_ignores=[])
    ast.fix_missing_locations(module)
    exec(compile(module, str(ui_path), "exec"), namespace)  # noqa: S102 - fixed, trusted source
    missing = [name for name in names if name not in namespace]
    if missing:
        raise SystemExit(f"Could not extract helpers from ui.py: {missing}")
    return ExtractedHelpers(namespace)


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument(
        "--python-root",
        default=str(Path(__file__).resolve().parents[1] / "python-app"),
        help="Directory containing the Qt application's switch_catalog package.",
    )
    parser.add_argument(
        "--out",
        default=str(Path(__file__).resolve().parents[1] / "tests" / "fixtures" / "legacy" / "behavior.json"),
    )
    args = parser.parse_args()

    python_root = Path(args.python_root).resolve()
    sys.path.insert(0, str(python_root))

    from switch_catalog import filename as fn
    from switch_catalog import http_server as hs
    from switch_catalog import metadata as md
    from switch_catalog import scanner as sc
    from switch_catalog import versions as vs

    try:
        from rapidfuzz import fuzz as rf_fuzz
    except ImportError:
        rf_fuzz = None

    helpers = extract_pure_helpers(
        python_root / "switch_catalog" / "ui.py",
        UI_FUNCTION_NAMES,
        {
            "Path": Path,
            "re": re,
            "extract_title_id": fn.extract_title_id,
            "detect_version": fn.detect_version,
            "raw_version_to_dotted": vs.raw_version_to_dotted,
            "is_shell_path": lambda value: str(value).strip().lower().startswith("shell:::")
            or str(value).strip().startswith("::{"),
            "AppSettings": object,
            "QUrl": _QUrl,
        },
    )

    payload: dict[str, Any] = {
        "source": "python-switch_catalog",
        "rapidfuzzAvailable": rf_fuzz is not None,
        "filename": [],
        "matching": [],
        "versions": {},
        "httpRange": [],
        "metadata": {},
        "ui": {},
    }

    for name in FILENAME_CASES:
        group = helpers["_update_file_group"](name)
        detected = fn.detect_version(name)
        payload["filename"].append(
            {
                "fileName": name,
                "supported": fn.is_supported_game_file(Path(name)),
                "detectVersion": detected,
                "titleId": fn.extract_title_id(name),
                "titleIdFamily": fn.title_id_family(name),
                "isUpdateOrDlc": fn.is_update_or_dlc_filename(name),
                "cleanedTitle": fn.clean_title(name),
                "cleanedTitleForUpdate": fn.clean_title(name, for_update=True),
                "updateGroup": group,
                "versionSuffix": helpers["_detected_version_suffix"](detected),
                "rawVersion": helpers["_detected_raw_version"](detected) if detected else 0,
            }
        )

    for update_name, game_names in MATCH_CASES:
        games = [
            {"id": index + 1, "display_title": fn.clean_title(game), "cleaned_title": fn.clean_title(game), "file_name": game}
            for index, game in enumerate(game_names)
        ]
        match_id, confidence = sc._match_update(update_name, games)
        id_match = sc._match_update_by_title_id(update_name, games)
        update_title = fn.clean_title(update_name, for_update=True).lower()
        payload["matching"].append(
            {
                "updateFileName": update_name,
                "gameFileNames": game_names,
                "updateTitle": update_title,
                "titleIdMatch": {"gameId": id_match[0], "confidence": id_match[1]},
                "bestMatch": {"gameId": match_id, "confidence": confidence},
                "scores": [
                    {
                        "gameId": game["id"],
                        "score": max(
                            sc._title_match_score(update_title, game["cleaned_title"].lower()),
                            sc._title_match_score(update_title, game["display_title"].lower()),
                        ),
                    }
                    for game in games
                ],
            }
        )

    payload["versions"] = {
        "dotted": {str(value): vs.raw_version_to_dotted(value) for value in [0, 255, 256, 65536, 131072, 196608, 16777216]},
        "labels": {str(value): vs.version_label(value) for value in [0, 65536, 131072, 196608]},
        "releasedLabels": {
            str(value): vs.released_version_label(value, "2023-05-12") for value in [65536, 131072]
        },
        "fileVersionNumbers": {
            text: vs.file_version_number(f"Game {text}.nsp")
            for text in ["v0", "v65536", "v1.0.0", "1.0", "2.1.0", "3.0.1", "1.0.0.0"]
        },
        "rawFromText": {
            text: helpers["_detected_raw_version"](text) for text in ["65536", "1.0.0", "300", "0"]
        },
        "compactDotted": {
            text: helpers["_compact_dotted_version"](text)
            for text in ["1.0.0", "1.0", "3.0.1", "1.2.3.0", "2.0.0"]
        },
        "parseVersionsTxt": vs.parse_versions_txt(VERSIONS_TXT_SAMPLE),
        "updateStatus": {},
    }

    for base_id, records in VERSIONS_JSON_SAMPLE.items():
        merged = vs._merge_versions(VERSIONS_JSON_SAMPLE, {})
        for updates in ([], ["Super Mario Odyssey [v131072].nsp"], ["Super Mario Odyssey [v262144].nsp"]):
            key = f"{base_id}|{','.join(updates) or 'none'}"
            status_text, available = vs.update_status(f"{base_id}.nsp", updates, merged)
            payload["versions"]["updateStatus"][key] = {
                "text": status_text,
                "available": [{"version": item.version, "release_date": item.release_date} for item in available],
            }
    merged_txt = vs._merge_versions(VERSIONS_JSON_SAMPLE, vs.parse_versions_txt(VERSIONS_TXT_SAMPLE))
    payload["versions"]["mergedTitleIds"] = sorted(merged_txt.keys())

    for size, header in RANGE_CASES:
        parsed = hs._parse_range(header, size)
        payload["httpRange"].append(
            {"size": size, "header": header, "expected": list(parsed) if parsed else None}
        )
    payload["httpContentDisposition"] = {
        name: hs._content_disposition(name) for name in ["Game.nsp", "Spiel Übersicht.nsp", "quote\"s.nsp"]
    }

    payload["metadata"] = {
        "normalizedTitles": {title: md.normalize_metadata_title(title) for title in METADATA_TITLE_CASES},
        "searchQueries": {title: md.metadata_search_queries(title) for title in METADATA_TITLE_CASES},
        "titleSimilarity": {
            f"{left}||{right}": md._title_similarity(left, right) for left, right in TITLE_SIMILARITY_PAIRS
        },
        "sequenceMatcherRatio": {
            f"{left}||{right}": __import__("difflib").SequenceMatcher(None, left, right).ratio()
            for left, right in TITLE_SIMILARITY_PAIRS
        },
        "fuzzRatio": (
            {f"{left}||{right}": rf_fuzz.ratio(left, right) / 100 for left, right in FUZZ_PAIRS}
            if rf_fuzz
            else None
        ),
        "escapeQuery": {
            value: md._escape_igdb_query(value)
            for value in ['plain', 'with "quotes"', "back\\slash", 'both "and" \\ here']
        },
    }

    payload["ui"] = {
        "formatBytes": {str(value): helpers["_format_bytes"](value) for value in BYTES_CASES},
        "installSizeText": {
            key: helpers["_install_size_text"](base, count, update_size)
            for key, (base, count, update_size) in {
                "none": (0, 0, 0),
                "base-only": (1024, 0, 0),
                "base-plus-updates": (5 * 1024**3, 3, 2 * 1024**3),
            }.items()
        },
        "pathIsInstallDestination": {
            f"{path}||{folder}": helpers["_path_is_install_destination"](path, folder)
            for path, folder in [
                (r"C:\Games\A.nsp", r"C:\Games"),
                (r"C:\Games\Sub\A.nsp", r"C:\Games"),
                (r"C:\Other\A.nsp", r"C:\Games"),
                ("", r"C:\Games"),
                ("shell:::abc\\A.nsp", "shell:::abc"),
            ]
        },
        "higherResImageUrl": {url: helpers["_higher_res_image_url"](url) for url in IMAGE_URL_CASES},
        "youtubePlayerUrl": {url: helpers["_youtube_player_url"](url) for url in YOUTUBE_URL_CASES},
        "youtubeEmbedUrl": {url: helpers["_youtube_embed_url"](url) for url in YOUTUBE_URL_CASES},
        "displayFolder": {
            "labelled-shell": helpers["_display_folder"]("shell:::abc", "Switch/SD Card Install"),
            "plain": helpers["_display_folder"](r"C:\Games", ""),
        },
        "metadataReady": {
            "with-secret": helpers["_metadata_ready"](
                type("S", (), {"igdb_client_id": "id", "igdb_client_secret": "secret"})()
            ),
            "without-secret": helpers["_metadata_ready"](
                type("S", (), {"igdb_client_id": "id", "igdb_client_secret": ""})()
            ),
        },
    }

    out_path = Path(args.out)
    out_path.parent.mkdir(parents=True, exist_ok=True)
    out_path.write_text(json.dumps(payload, indent=2, ensure_ascii=False, sort_keys=False), encoding="utf-8")
    print(f"wrote {out_path} ({out_path.stat().st_size} bytes)")

    write_legacy_schema_snapshot(python_root, out_path.parent)
    return 0


def write_legacy_schema_snapshot(python_root: Path, fixture_dir: Path) -> None:
    """Snapshot the Qt application's SQLite schema exactly as it creates it.

    The Electron build must open this schema without destructive conversion
    (spec 10), so the snapshot is a regression fixture rather than documentation.
    """
    import sqlite3
    import tempfile

    with tempfile.TemporaryDirectory() as workdir:
        database = Path(workdir) / "library.sqlite3"
        connection = sqlite3.connect(database)
        try:
            connection.executescript(LEGACY_SCHEMA_SQL)
            connection.commit()
            rows = connection.execute(
                """
                SELECT type, name, sql FROM sqlite_master
                WHERE sql IS NOT NULL AND name NOT LIKE 'sqlite_%'
                ORDER BY CASE type WHEN 'table' THEN 0 ELSE 1 END, name
                """
            ).fetchall()
        finally:
            connection.close()

    target = fixture_dir / "legacy-schema.sql"
    lines = [
        "-- Qt application schema snapshot, generated by scripts/capture-fixtures.py.",
        "-- Kept verbatim so the Electron migration layer can be tested against the real shape.",
    ]
    lines.extend(f"{sql};\n" for _type, _name, sql in rows)
    target.write_text("\n".join(lines), encoding="utf-8")
    print(f"wrote {target} ({len(rows)} objects)")


if __name__ == "__main__":
    raise SystemExit(main())
