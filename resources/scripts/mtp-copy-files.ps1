$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'
trap { [Console]::Error.WriteLine($_.Exception.Message); exit 1 }
$destPath = $env:SWITCH_CATALOG_MTP_DESTINATION
$sourceCount = [int]$env:SWITCH_CATALOG_MTP_SOURCE_COUNT
if ($sourceCount -le 0) {
    throw 'No source files were supplied for the MTP transfer.'
}
$sourcePaths = @()
for ($index = 0; $index -lt $sourceCount; $index++) {
    $sourcePath = [Environment]::GetEnvironmentVariable("SWITCH_CATALOG_MTP_SOURCE_$index")
    if ([string]::IsNullOrEmpty($sourcePath)) {
        throw "MTP source path $index is missing."
    }
    $sourcePaths += $sourcePath
}
$timeoutSeconds = [int]$env:SWITCH_CATALOG_MTP_TIMEOUT

# Validate the whole batch before asking Windows to copy anything. A batch is
# one Shell operation even when its source files live in different folders.
$shell = New-Object -ComObject Shell.Application
$dest = $shell.Namespace($destPath)
if ($null -eq $dest -and $destPath.StartsWith('shell:')) {
    $dest = $shell.Namespace($destPath.Substring(6))
}
if ($null -eq $dest) {
    $lastSlash = $destPath.LastIndexOf('\')
    if ($lastSlash -ge 0) {
        $parent = $shell.Namespace($destPath.Substring(0, $lastSlash))
        if ($null -ne $parent) {
            foreach ($item in $parent.Items()) {
                if ($item.Path -eq $destPath -or ('shell:' + $item.Path) -eq $destPath) {
                    $dest = $item.GetFolder
                    break
                }
            }
        }
    }
}
if ($null -eq $dest) {
    throw "MTP destination is not available: $destPath"
}
$names = @{}
foreach ($sourcePath in $sourcePaths) {
    if (-not [System.IO.File]::Exists($sourcePath)) {
        throw "Source file is missing: $sourcePath"
    }
    $fileName = [System.IO.Path]::GetFileName($sourcePath)
    if ($names.ContainsKey($fileName)) {
        throw "The selected files contain the same name: $fileName"
    }
    $names[$fileName] = $true
    if ($null -ne $dest.ParseName($fileName)) {
        throw "A file named '$fileName' already exists on the MTP destination."
    }
}

Add-Type @"
using System;
using System.Runtime.InteropServices;

[ComImport, Guid("43826d1e-e718-42ee-bc55-a1e261c37bfe")]
[InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
public interface IMtpShellItem {}

[ComImport, Guid("947aab5f-0a5c-4c13-b4d6-4bf7836fc9f8")]
[InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
public interface IMtpFileOperation {
    void Advise(IntPtr sink, out uint cookie);
    void Unadvise(uint cookie);
    void SetOperationFlags(uint flags);
    void SetProgressMessage([MarshalAs(UnmanagedType.LPWStr)] string message);
    void SetProgressDialog(IntPtr dialog);
    void SetProperties(IntPtr properties);
    void SetOwnerWindow(IntPtr window);
    void ApplyPropertiesToItem(IMtpShellItem item);
    void ApplyPropertiesToItems(IntPtr items);
    void RenameItem(IMtpShellItem item, [MarshalAs(UnmanagedType.LPWStr)] string name, IntPtr sink);
    void RenameItems(IntPtr items, [MarshalAs(UnmanagedType.LPWStr)] string name);
    void MoveItem(IMtpShellItem item, IMtpShellItem destination, [MarshalAs(UnmanagedType.LPWStr)] string name, IntPtr sink);
    void MoveItems(IntPtr items, IMtpShellItem destination);
    void CopyItem(IMtpShellItem item, IMtpShellItem destination, [MarshalAs(UnmanagedType.LPWStr)] string name, IntPtr sink);
    void CopyItems(IntPtr items, IMtpShellItem destination);
    void DeleteItem(IMtpShellItem item, IntPtr sink);
    void DeleteItems(IntPtr items);
    void NewItem(IMtpShellItem destination, uint attributes, [MarshalAs(UnmanagedType.LPWStr)] string name,
        [MarshalAs(UnmanagedType.LPWStr)] string templateName, IntPtr sink);
    void PerformOperations();
    void GetAnyOperationsAborted([MarshalAs(UnmanagedType.Bool)] out bool aborted);
}

public static class MtpBatchCopy {
    [DllImport("shell32.dll", CharSet = CharSet.Unicode, PreserveSig = false)]
    private static extern void SHCreateItemFromParsingName(
        [MarshalAs(UnmanagedType.LPWStr)] string path, IntPtr bindContext,
        [In] ref Guid interfaceId, [MarshalAs(UnmanagedType.Interface)] out IMtpShellItem item);

    private static IMtpShellItem Parse(string path) {
        Guid id = typeof(IMtpShellItem).GUID;
        IMtpShellItem item;
        try {
            SHCreateItemFromParsingName(path, IntPtr.Zero, ref id, out item);
        } catch (COMException) {
            if (!path.StartsWith("shell:", StringComparison.OrdinalIgnoreCase)) throw;
            SHCreateItemFromParsingName(path.Substring(6), IntPtr.Zero, ref id, out item);
        }
        return item;
    }

    public static void Copy(string destinationPath, string[] sources) {
        IMtpFileOperation operation = null;
        IMtpShellItem destination = null;
        string stage = "resolve destination";
        bool started = false;
        try {
            destination = Parse(destinationPath);
            stage = "create file operation";
            operation = (IMtpFileOperation)Activator.CreateInstance(
                Type.GetTypeFromCLSID(new Guid("3ad05575-8857-4850-9277-11b85bdb8e09")));
            // No confirmation or error dialogs; stop the batch on the first error.
            stage = "set operation flags";
            operation.SetOperationFlags(0x00100410);
            foreach (string sourcePath in sources) {
                stage = "queue " + sourcePath;
                IMtpShellItem source = Parse(sourcePath);
                try {
                    operation.CopyItem(source, destination, null, IntPtr.Zero);
                } finally {
                    Marshal.ReleaseComObject(source);
                }
            }
            stage = "perform operations";
            started = true;
            operation.PerformOperations();
            stage = "check operation result";
            bool aborted;
            operation.GetAnyOperationsAborted(out aborted);
            if (aborted) throw new InvalidOperationException("Windows stopped the MTP batch transfer before it finished.");
        } catch (Exception error) {
            throw new InvalidOperationException((started ? "MTP_TRANSFER_FAILED" : "MTP_PRETRANSFER_FAILED")
                + " at " + stage + ": " + error.Message, error);
        } finally {
            if (operation != null) Marshal.ReleaseComObject(operation);
            if (destination != null) Marshal.ReleaseComObject(destination);
        }
    }
}
"@

try {
    [MtpBatchCopy]::Copy($destPath, [string[]]$sourcePaths)
    Write-Output 'MTP_METHOD: IFileOperation'
} catch {
    $cause = $_.Exception
    while ($null -ne $cause -and -not $cause.Message.StartsWith('MTP_PRETRANSFER_FAILED')) {
        $cause = $cause.InnerException
    }
    if ($null -eq $cause) { throw }
    # DBI's virtual install folder can reject IFileOperation before any copy starts.
    # The Shell.Application path was used by the earlier working transfer flow.
    Write-Output "MTP_FALLBACK: $($cause.Message)"

    Add-Type @"
using System;
using System.Collections.Generic;
using System.Runtime.InteropServices;
using System.Text;
public static class SwitchCatalogWindowProbe {
    public delegate bool EnumWindowsProc(IntPtr window, IntPtr data);
    [DllImport("user32.dll")] public static extern bool EnumWindows(EnumWindowsProc callback, IntPtr data);
    [DllImport("user32.dll")] public static extern bool IsWindowVisible(IntPtr window);
    [DllImport("user32.dll", CharSet = CharSet.Unicode)]
    public static extern int GetWindowText(IntPtr window, StringBuilder text, int count);
    [DllImport("user32.dll", CharSet = CharSet.Unicode)]
    public static extern int GetClassName(IntPtr window, StringBuilder text, int count);
    public static string[] VisibleWindows() {
        List<string> rows = new List<string>();
        EnumWindows(delegate(IntPtr window, IntPtr data) {
            if (!IsWindowVisible(window)) return true;
            StringBuilder title = new StringBuilder(512);
            StringBuilder name = new StringBuilder(256);
            GetWindowText(window, title, title.Capacity);
            GetClassName(window, name, name.Capacity);
            rows.Add(name.ToString() + "\t" + title.ToString());
            return true;
        }, IntPtr.Zero);
        return rows.ToArray();
    }
}
"@
    function Get-FileOperationWindowCount {
        return @([SwitchCatalogWindowProbe]::VisibleWindows() | Where-Object {
            $_ -match '^OperationStatusWindow\t' -or
            $_ -match '(?i)\b(copying|moving|calculating|replacing)\b'
        }).Count
    }
    function Wait-ForShellFileOperation([int]$seconds) {
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
            throw 'Windows did not show a transfer operation, so completion could not be confirmed.'
        }
        $deadline = (Get-Date).AddSeconds($seconds)
        do {
            Start-Sleep -Seconds 1
            if ((Get-FileOperationWindowCount) -eq 0) {
                Start-Sleep -Seconds 2
                return
            }
        } while ((Get-Date) -lt $deadline)
        throw "Windows file transfer window did not close before the $seconds second timeout."
    }
    foreach ($sourcePath in $sourcePaths) {
        Write-Output "MTP_COPYING: $sourcePath"
        try {
            $dest.CopyHere($sourcePath, 16)
            Wait-ForShellFileOperation $timeoutSeconds
        } catch {
            throw "Shell transfer failed for '$sourcePath': $($_.Exception.Message)"
        }
    }
    Write-Output 'MTP_METHOD: Shell.CopyHere'
}
