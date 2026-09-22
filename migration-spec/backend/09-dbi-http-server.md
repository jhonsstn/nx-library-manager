# 09 — DBI HTTP Server

## Goal

Maintain compatibility with the current built-in HTTP source used by DBI, including range requests and Apache-style directory listing behavior.

## Lifecycle

The HTTP server is owned by the main process.

It may be:
- disabled;
- enabled automatically on startup;
- started/stopped from Settings.

Only one instance may run.

## Binding

Initial behavior may bind to all local interfaces to preserve current LAN behavior.

The status API should expose:
- running state;
- port;
- detected LAN URL;
- authentication enabled state.

## Routes

Preserve compatibility where practical:

```text
GET/HEAD /
GET/HEAD /dir/
GET/HEAD /dir/<filename>
GET/HEAD /dl/game/<id>/<filename>
GET/HEAD /dl/update/<id>/<filename>
GET/HEAD /list.txt
GET/HEAD /awoo.txt
```

## Catalog-only access

A request may only resolve to a row already indexed in SQLite.

Never concatenate arbitrary URL paths into filesystem paths.

## Range support

Required:
- `Range: bytes=start-end`;
- open-ended ranges where current behavior supports them;
- `206 Partial Content`;
- `Content-Range`;
- `Accept-Ranges: bytes`;
- correct `Content-Length`;
- `416 Requested Range Not Satisfiable` for invalid ranges.

Range parsing should be implemented as a pure function and unit tested.

## Streaming

Use file streams with bounded chunks; do not read multi-gigabyte files into memory.

Handle client disconnects gracefully.

## Authentication

Optional HTTP Basic Auth.

Requirements:
- constant-time credential comparison where practical;
- credentials not logged;
- `WWW-Authenticate` response on failure.

## Directory listing

Generate minimal valid HTML compatible with DBI expectations.

Escape filenames for HTML and encode them for URLs separately.

## Public internet warning

Settings must state that Basic Auth on plain HTTP does not encrypt credentials or traffic.

Recommend private network access such as Tailscale/WireGuard for remote access.

## Logging

Server logs may include:
- request timestamp;
- method;
- route category;
- status;
- range header;
- bytes sent;
- client address if useful.

Do not log authorization headers.

