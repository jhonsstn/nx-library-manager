# 15 — Packaging and Application Updates

## Target OS

Windows 10/11 x64 initially.

ARM64 may be added after validating native dependencies such as `better-sqlite3` and packaging pipeline.

## Build outputs

Provide:
- standard installer `.exe`;
- optional portable `.exe` or zipped portable build.

## Installer behavior

- install per-user by default unless admin install is explicitly needed;
- Start Menu shortcut;
- optional Desktop shortcut;
- no user catalog data stored in install directory;
- uninstall does not delete catalog database/settings without explicit user choice.

## Native dependencies

CI/build pipeline must rebuild native Electron modules for the targeted Electron version.

`better-sqlite3` requires correct Electron ABI packaging.

## Code signing

Recommended for public distribution to reduce Windows SmartScreen friction.

Unsigned builds are acceptable for early personal/test releases but should not be considered polished distribution.

## Release artifacts

GitHub Release should contain:
- installer;
- portable build if supported;
- checksums;
- release notes.

## Update checking

The initial update checker should:
- query latest GitHub release;
- compare semantic versions;
- notify user;
- open release page.

## Auto-update

Automatic update installation is deferred.

If added later:
- use signed releases;
- do not auto-update during active install/scan;
- support restart-to-update UX;
- retain rollback/recovery considerations.

## Versioning

Use semantic versioning where possible:

```text
0.1.0
0.2.0
1.0.0
```

Prerelease identifiers must follow SemVer ordering.

## CI outline

On tag:
1. install dependencies;
2. type-check;
3. run unit/integration tests;
4. build renderer/main/preload;
5. package Electron app;
6. run smoke test where feasible;
7. generate checksums;
8. attach artifacts to GitHub Release.
