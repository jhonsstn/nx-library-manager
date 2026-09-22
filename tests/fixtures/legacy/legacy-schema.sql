-- Frozen snapshot of the schema the Qt application created for library.sqlite3.
-- Kept verbatim so the migration layer can be tested against the real shape.
CREATE TABLE game_files (
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

CREATE TABLE games (
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

CREATE TABLE install_jobs (
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

CREATE TABLE metadata_cache (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    provider TEXT NOT NULL,
    query TEXT NOT NULL,
    response_json TEXT NOT NULL,
    cached_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
    UNIQUE(provider, query)
);

CREATE TABLE screenshots (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    game_id INTEGER NOT NULL REFERENCES games(id) ON DELETE CASCADE,
    image_url TEXT NOT NULL,
    local_path TEXT,
    sort_order INTEGER NOT NULL DEFAULT 0,
    UNIQUE(game_id, image_url)
);

CREATE TABLE updates (
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
