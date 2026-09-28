$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'
$destPath = $env:SWITCH_CATALOG_MTP_DESTINATION
$sourcePaths = @($env:SWITCH_CATALOG_MTP_SOURCES | ConvertFrom-Json)
if ($sourcePaths.Count -eq 0) {
    throw 'No source files were supplied for the MTP transfer.'
}

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
        try {
            destination = Parse(destinationPath);
            operation = (IMtpFileOperation)Activator.CreateInstance(
                Type.GetTypeFromCLSID(new Guid("3ad05575-8857-4850-9277-11b85bdb8e09")));
            // No confirmation or error dialogs; stop the batch on the first error.
            operation.SetOperationFlags(0x00100410);
            foreach (string sourcePath in sources) {
                IMtpShellItem source = Parse(sourcePath);
                try {
                    operation.CopyItem(source, destination, null, IntPtr.Zero);
                } finally {
                    Marshal.ReleaseComObject(source);
                }
            }
            operation.PerformOperations();
            bool aborted;
            operation.GetAnyOperationsAborted(out aborted);
            if (aborted) throw new InvalidOperationException("Windows stopped the MTP batch transfer before it finished.");
        } finally {
            if (operation != null) Marshal.ReleaseComObject(operation);
            if (destination != null) Marshal.ReleaseComObject(destination);
        }
    }
}
"@

[MtpBatchCopy]::Copy($destPath, [string[]]$sourcePaths)
