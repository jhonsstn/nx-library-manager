$ErrorActionPreference = 'Stop'
$title = $env:SWITCH_CATALOG_MTP_PICKER_TITLE
$shell = New-Object -ComObject Shell.Application
$folder = $shell.BrowseForFolder(0, $title, 0x00000040, 17)
if ($null -eq $folder) {
    exit 2
}
$path = $folder.Self.Path
if ([string]::IsNullOrWhiteSpace($path)) {
    throw "Selected folder did not provide a Shell path."
}
if ($path.StartsWith("::{")) {
    $path = "shell:$path"
}
function Get-FriendlyPath($folder) {
    $names = New-Object System.Collections.Generic.List[string]
    $current = $folder
    while ($null -ne $current -and $null -ne $current.Self) {
        $name = $current.Self.Name
        if (-not [string]::IsNullOrWhiteSpace($name)) {
            $names.Insert(0, $name)
        }
        $parent = $current.ParentFolder
        if ($null -eq $parent -or $null -eq $parent.Self) {
            break
        }
        if ($parent.Self.Path -eq $current.Self.Path) {
            break
        }
        $current = $parent
    }
    while ($names.Count -gt 0 -and ($names[0] -eq "Desktop" -or $names[0] -eq "This PC")) {
        $names.RemoveAt(0)
    }
    if ($names.Count -eq 0) {
        return $folder.Self.Name
    }
    return ($names -join "/")
}
$label = Get-FriendlyPath $folder
[Console]::OutputEncoding = [System.Text.Encoding]::UTF8
[PSCustomObject]@{ path = $path; label = $label } | ConvertTo-Json -Compress
