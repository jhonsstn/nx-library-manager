# 06 — Filename Matching and Version Logic

## Goal

Port current filename/title/version behavior as pure TypeScript functions with strong test coverage before optimizing or changing matching semantics.

## Filename parser output

```ts
interface ParsedSwitchFilename {
  originalName: string;
  extension: 'nsp' | 'nsz' | 'xci';
  normalizedTitle: string;
  titleId?: string;
  rawVersion?: string;
  versionNumber?: number;
  markers: string[];
  probableKind: 'base' | 'update' | 'dlc' | 'unknown';
}
```

## Title ID extraction

Retain existing accepted title-ID syntax from the Python implementation.

Normalization:
- uppercase;
- remove surrounding separators;
- validate expected hexadecimal length/shape before use.

Invalid IDs are ignored rather than partially accepted.

## Title normalization

Normalization should be deterministic and testable.

Likely operations:
- remove known bracketed metadata;
- normalize punctuation variants;
- collapse whitespace;
- strip version/update markers;
- case-fold for comparison;
- keep display title separately from matching key.

Do not destructively overwrite the user's original filename-derived display title without preserving the source.

## Matching priority

1. Manual match already stored in DB.
2. Exact compatible title ID relation.
3. Exact normalized title.
4. Strong fuzzy normalized-title match.
5. Otherwise unmatched.

## Fuzzy score

Choose a maintained JavaScript fuzzy library or implement the exact scoring needed.

Store score normalized to `[0, 1]`.

Suggested thresholds should initially mirror the current Python behavior rather than being retuned during migration.

Example policy:
- `>= 0.92`: auto-match if no conflicting stronger candidate;
- `0.80–0.92`: review candidate;
- `< 0.80`: unmatched.

These numbers are placeholders until current behavior is captured in tests.

## Ambiguity

If the best and second-best candidates are too close, do not auto-match.

Example:

```text
best = 0.93
second = 0.92
```

Result: Needs Review, not automatic association.

## Manual matching

Manual user choices set:
- `game_id`;
- `manual_match = 1`.

Automated scans must not replace manual matches while both records remain valid.

## Version parsing

Preserve both:
- raw version from filename/data source;
- user-facing dotted version.

Do not compare version strings lexicographically.

Use numeric canonical representation for comparisons.

## TitleDB version service

Responsibilities:
- load cached version database;
- determine staleness;
- refresh after approximately 24 hours;
- retain previous cache if refresh fails;
- map title ID to latest known version;
- provide current/local/latest status.

## Update status enum

```ts
type UpdateStatus =
  | 'unknown'
  | 'current'
  | 'update-available'
  | 'local-newer'
  | 'missing-local-version';
```

`local-newer` must not be labeled as an error; remote datasets may lag or differ.

## Required regression fixtures

Before porting, create fixtures from representative current filenames:
- clean base game;
- base with title ID;
- update with `vNNNN`;
- DLC-like title;
- punctuation-heavy game title;
- regional naming variant;
- duplicate update versions;
- false-positive fuzzy pair.

Python and TypeScript outputs should be compared during migration where practical.

