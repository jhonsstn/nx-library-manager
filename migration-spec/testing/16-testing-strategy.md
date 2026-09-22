# 16 — Testing Strategy

## Principle

The migration should lock in current behavior through tests before changing algorithms.

## Unit tests

### Filename parser

Cover:
- extensions;
- title IDs;
- version extraction;
- bracket cleanup;
- punctuation normalization;
- base/update/DLC classification.

### Matching

Cover:
- exact title ID;
- exact normalized title;
- fuzzy match;
- ambiguous candidate rejection;
- manual match precedence.

### Version logic

Cover:
- numeric comparison;
- dotted display conversion;
- current/update-available/local-newer;
- missing data.

### HTTP Range parser

Cover:
- full range;
- start-end;
- open end;
- invalid start/end;
- beyond EOF;
- empty file edge cases.

### Settings validation

Cover:
- defaults;
- malformed settings;
- port bounds;
- missing folders;
- secret masking.

## Integration tests

### Database

Use temporary SQLite DB.

Test:
- init;
- migrations;
- favorite mutation;
- manual matches;
- scan reconciliation;
- existing-schema import fixtures.

### Scanner

Build temporary folder trees with fake small files named like Switch packages.

No need to include real copyrighted game data.

Test:
- recursion;
- duplicate paths;
- removed files;
- moved files;
- unmatched updates;
- cancellation.

### Metadata

Mock HTTP.

Test:
- token request;
- cache hit;
- Switch-first search;
- fallback search;
- rate limit/auth failures.

### DBI server

Start on ephemeral port.

Test:
- listing;
- auth;
- GET/HEAD;
- Range;
- resume;
- unknown IDs;
- path traversal attempts.

## Renderer tests

React Testing Library:
- filters;
- favorites toggle;
- details state;
- unmatched match dialog;
- settings validation;
- scan progress rendering;
- failure states.

## E2E tests

Playwright + Electron.

Critical smoke flows:
1. app launches;
2. loads seeded library;
3. search/filter works;
4. open game details;
5. favorite persists after restart;
6. run scan against fixture directory;
7. start/stop HTTP server;
8. settings persist.

## Manual Windows hardware matrix

Required before release:

| Test | SD | NAND | Notes |
| --- | --- | --- | --- |
| Detect Switch | Yes | Yes | DBI/MTP mode |
| Read free space | Yes | Yes | Compare with device |
| Small file transfer | Yes | Yes | Basic reliability |
| Large transfer | Yes | Yes | Multi-GB test |
| Device disconnect | Yes | Yes | Error handling |
| App close during idle | N/A | N/A | clean shutdown |
| Wi-Fi DBI listing | N/A | N/A | LAN |
| Wi-Fi ranged download | N/A | N/A | resume/range |

## Regression comparison with Python app

For the same fixture library capture from both implementations:
- game count;
- update count;
- unmatched count;
- parsed title IDs;
- detected versions;
- automatic associations.

Differences require explicit review, not assumption that the new output is better.

