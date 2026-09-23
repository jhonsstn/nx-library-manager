$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'
$destPath = $env:SWITCH_CATALOG_MTP_DESTINATION
$sourcePath = $env:SWITCH_CATALOG_MTP_SOURCE
$timeoutSeconds = [int]$env:SWITCH_CATALOG_MTP_TIMEOUT
$fileName = [System.IO.Path]::GetFileName($sourcePath)
$sourceSize = (Get-Item -LiteralPath $sourcePath).Length
$shell = New-Object -ComObject Shell.Application
Add-Type @"
using System;
using System.Collections.Generic;
using System.Runtime.InteropServices;
using System.Text;

public static class SwitchCatalogWindowProbe {
    public delegate bool EnumWindowsProc(IntPtr hWnd, IntPtr lParam);

    [DllImport("user32.dll")]
    public static extern bool EnumWindows(EnumWindowsProc enumProc, IntPtr lParam);

    [DllImport("user32.dll")]
    public static extern bool IsWindowVisible(IntPtr hWnd);

    [DllImport("user32.dll", CharSet = CharSet.Unicode)]
    public static extern int GetWindowText(IntPtr hWnd, StringBuilder text, int count);

    [DllImport("user32.dll", CharSet = CharSet.Unicode)]
    public static extern int GetClassName(IntPtr hWnd, StringBuilder text, int count);

    public static string[] VisibleWindows() {
        List<string> rows = new List<string>();
        EnumWindows(delegate(IntPtr hWnd, IntPtr lParam) {
            if (!IsWindowVisible(hWnd)) {
                return true;
            }
            StringBuilder title = new StringBuilder(512);
            StringBuilder className = new StringBuilder(256);
            GetWindowText(hWnd, title, title.Capacity);
            GetClassName(hWnd, className, className.Capacity);
            rows.Add(className.ToString() + "\t" + title.ToString());
            return true;
        }, IntPtr.Zero);
        return rows.ToArray();
    }
}
"@
function Get-FileOperationWindowCount {
    $windows = [SwitchCatalogWindowProbe]::VisibleWindows()
    return @(
        $windows | Where-Object {
            $_ -match '^OperationStatusWindow\t' -or
            $_ -match '(?i)\b(copying|moving|calculating|replacing)\b'
        }
    ).Count
}
function Get-EstimatedInstallWait([int64]$bytes, [int]$timeoutSeconds) {
    $seconds = [int][Math]::Ceiling($bytes / 12MB) + 45
    if ($seconds -lt 30) {
        $seconds = 30
    }
    if ($seconds -gt $timeoutSeconds) {
        $seconds = $timeoutSeconds
    }
    return $seconds
}
function Wait-ForShellFileOperation([int]$timeoutSeconds, [int64]$sourceSize) {
    $seenWindow = $false
    $startDeadline = (Get-Date).AddSeconds(20)
    do {
        if ((Get-FileOperationWindowCount) -gt 0) {
            $seenWindow = $true
            break
        }
        Start-Sleep -Milliseconds 500
    } while ((Get-Date) -lt $startDeadline)
    if (-not $seenWindow) {
        Start-Sleep -Seconds (Get-EstimatedInstallWait $sourceSize $timeoutSeconds)
        return
    }
    $deadline = (Get-Date).AddSeconds($timeoutSeconds)
    do {
        Start-Sleep -Seconds 1
        if ((Get-FileOperationWindowCount) -eq 0) {
            Start-Sleep -Seconds 2
            return
        }
    } while ((Get-Date) -lt $deadline)
    throw "Windows file transfer window did not close before the $timeoutSeconds second timeout."
}
function Resolve-ShellFolder($path) {
    $paths = @($path)
    if ($path.StartsWith("shell:")) {
        $paths += $path.Substring(6)
    }
    foreach ($candidate in $paths) {
        $folder = $shell.Namespace($candidate)
        if ($null -ne $folder) {
            return $folder
        }
    }
    foreach ($candidate in $paths) {
        $lastSlash = $candidate.LastIndexOf("\")
        if ($lastSlash -lt 0) {
            continue
        }
        $parentPath = $candidate.Substring(0, $lastSlash)
        $parent = $shell.Namespace($parentPath)
        if ($null -eq $parent) {
            continue
        }
        foreach ($item in $parent.Items()) {
            if ($item.Path -eq $candidate -or ("shell:" + $item.Path) -eq $path) {
                return $item.GetFolder
            }
        }
    }
    return $null
}
$dest = Resolve-ShellFolder $destPath
if ($null -eq $dest) {
    throw "MTP destination is not available: $destPath"
}
if ($null -ne $dest.ParseName($fileName)) {
    throw "A file named '$fileName' already exists on the MTP destination."
}
$dest.CopyHere($sourcePath, 16)
Wait-ForShellFileOperation $timeoutSeconds $sourceSize
