# 04 — Errors, Logging, and Security

## Error handling principles

- Domain errors use stable codes.
- Raw stack traces are logged but not shown directly to users.
- UI messages should describe the failed action and a useful next step.
- Failure of metadata/version services must not make the local library unusable.
- Destructive operations fail closed.

## Logging

Use a structured logger in the main process.

Minimum fields:
- timestamp;
- level;
- subsystem;
- event;
- job ID if applicable;
- game/update ID if applicable;
- safe contextual metadata.

Example:

```json
{
  "level": "info",
  "subsystem": "scanner",
  "event": "scan.completed",
  "jobId": "scan_123",
  "gamesFound": 327,
  "elapsedMs": 12844
}
```

## Log retention

Default recommendation:
- rolling log files;
- keep 5 files;
- cap each at roughly 5–10 MB.

## Sensitive data never logged

- IGDB client secret;
- OAuth bearer tokens;
- HTTP server password;
- authorization headers;
- full environment dumps.

Paths may be logged for diagnostics, but an optional privacy mode can redact home-directory prefixes later.

## Electron security configuration

BrowserWindow baseline:

```ts
webPreferences: {
  preload,
  contextIsolation: true,
  nodeIntegration: false,
  sandbox: true
}
```

If a concrete required feature is incompatible with sandboxing, document and isolate the exception rather than globally enabling unsafe settings.

## Navigation restrictions

- deny unexpected renderer navigation;
- deny arbitrary `window.open`;
- route external URLs through `shell.openExternal` after URL validation;
- allow only `https:` for normal external links unless a documented local protocol is necessary.

## Content Security Policy

Renderer should use a restrictive CSP.

Production should not require `unsafe-eval`.

Example target:

```text
default-src 'self';
img-src 'self' data: file: https:;
media-src 'self' https:;
connect-src 'self';
script-src 'self';
style-src 'self' 'unsafe-inline';
```

Remote images should preferably be downloaded/cached by the main process rather than loaded with privileged credentials from the renderer.

## Path validation

Dangerous commands such as delete/move/install must use records retrieved from SQLite whenever possible.

Preferred pattern:

```text
renderer sends updateFileId
main resolves updateFileId -> canonical file path
main validates path exists and belongs to known catalog
main performs operation
```

Avoid:

```text
renderer sends C:\whatever\file.nsp
main deletes it directly
```

## Destructive actions

The renderer displays confirmation UX, but the main process must still validate the target.

Deletion should optionally support a future Recycle Bin adapter, but parity release may preserve permanent deletion behavior if clearly stated.

## Local HTTP server

- binds to configured port;
- serves cataloged files only;
- no arbitrary filesystem traversal;
- canonicalize and validate all names/IDs;
- protect credentials from logs;
- retain current warning against direct public internet exposure.

