# 14 — Windows MTP Specification

## Context

The existing Python application contains Windows-specific MTP logic using PowerShell and the Windows Shell COM object model.

The first Electron release should preserve this behavior rather than simultaneously redesigning the MTP implementation.

## Abstraction

All MTP functionality must sit behind `MtpAdapter`.

```ts
interface MtpAdapter {
  getStatus(): Promise<MtpStatus>;
  copy(input: MtpCopyInput, signal?: AbortSignal): Promise<void>;
}
```

No renderer or catalog service may invoke PowerShell directly.

## Initial implementation

`PowerShellMtpAdapter`

Node launches:

```text
powershell.exe
-NoProfile
-NonInteractive
-ExecutionPolicy Bypass (only if truly required; avoid if possible)
-Command <controlled script>
```

Prefer passing structured data through stdin/temp files or JSON rather than interpolating arbitrary renderer text into shell source.

## Device detection

Preserve current heuristics:
- enumerate `shell:MyComputerFolder`;
- identify device name/path resembling Nintendo Switch;
- enumerate child storage locations;
- normalize `SD install` and `NAND install`;
- read free/total storage through extended properties or shell detail columns.

## Storage DTO

```ts
interface MtpStorageInfo {
  id: 'sd' | 'nand';
  label: string;
  shellPath: string;
  freeBytes?: number;
  totalBytes?: number;
}
```

## Refresh

- initial refresh shortly after startup;
- periodic refresh approximately every 60 seconds while app is open;
- manual refresh button;
- refresh before starting install.

Avoid overlapping PowerShell status jobs.

## Copy/install

Current working shell-copy behavior should be ported with minimal semantic changes.

Requirements:
- validate local source path exists;
- resolve MTP destination from adapter status rather than renderer text;
- surface timeout/failure;
- preserve filename;
- allow queue-level ordering.

## Timeouts

Status commands should have a short timeout similar to existing behavior (around 8 seconds).

Long transfer commands need separate transfer timeout policy and should not use the status timeout.

## Cancellation

Only advertise cancellability if the underlying transfer can be safely cancelled.

If terminating PowerShell risks leaving corrupt/incomplete destination state, UI should indicate that active transfer cannot be safely cancelled.

## Future native implementation

Potential later replacement:
- Windows Portable Devices API / COM through native Node addon or sidecar;
- Rust helper with `windows` crate;
- C# helper process.

The `MtpAdapter` interface is intentionally designed so this can be replaced without changing React or install-service logic.

