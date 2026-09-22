# 07 — Metadata Service

## Provider

Initial provider: IGDB through Twitch OAuth client credentials.

## Responsibilities

- maintain credentials;
- obtain access token;
- search candidate games;
- prefer Nintendo Switch platform candidates;
- fall back to broader search when necessary;
- score candidates against normalized local title;
- cache provider responses;
- persist selected metadata;
- cache cover/screenshots locally where practical.

## Credentials

Settings fields:
- `igdbClientId`;
- `igdbClientSecret`.

The client secret is owned by the main process.

Renderer receives only whether a secret is configured unless the user explicitly chooses to replace it.

## Token cache

OAuth access token should be cached with expiry.

Cache OAuth token payloads with their expiry in main-process-owned storage.

Do not request a new token for every game.

## Search flow

1. Build normalized candidate queries.
2. Search with Switch platform restriction.
3. Score returned names against source title.
4. If no acceptable candidate, retry without platform restriction.
5. Return ordered candidate list.
6. Auto-apply only if confidence satisfies the configured threshold.

## Stored fields

- provider;
- provider ID;
- display title;
- description;
- release date;
- developer;
- publisher;
- genres;
- cover URL/path;
- trailer URL;
- screenshots;
- confidence/source metadata if useful.

## Cache

Cache keys should include a cache schema/version so matching changes can invalidate old searches without wiping unrelated metadata.

Example:

```text
igdb:search:v3:switch:super mario odyssey
```

## Images

Preferred architecture:
- main process downloads cover/screenshot files into app cache;
- database stores local cache path plus origin URL;
- renderer displays local URLs through a safe custom protocol or approved file URL strategy.

Benefits:
- faster library rendering;
- fewer remote loads;
- works offline after cache;
- simpler CSP.

## Refresh behavior

Manual metadata refresh should allow:
- retry automatic best match;
- display candidate search results;
- apply a selected candidate;
- lock metadata so rescans do not overwrite a manual choice.

## Failure behavior

Network or IGDB failures:
- do not block scans;
- retain existing cached metadata;
- mark operation retryable;
- show concise user-facing error.

## Rate limiting

Metadata bulk refresh must use limited concurrency and backoff.

Suggested initial concurrency: 3.

Do not retry authentication failures indefinitely.
