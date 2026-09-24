$ErrorActionPreference = 'Stop'
[Console]::OutputEncoding = [System.Text.Encoding]::UTF8
$shell = New-Object -ComObject Shell.Application
$root = $shell.Namespace('shell:MyComputerFolder')
$result = [ordered]@{ state = 'unavailable'; device_id = $null; files = @(); unidentified_files = 0; message = 'No Switch MTP device found.' }
if ($null -eq $root) {
    $result | ConvertTo-Json -Depth 5 -Compress
    exit 0
}
$devices = @($root.Items() | Where-Object {
    "$($_.Name)" -match '(?i)switch|nintendo' -or "$($_.Path)" -match '(?i)vid_057e|pid_201d'
})
if ($devices.Count -ne 1) {
    if ($devices.Count -gt 1) { $result.message = 'More than one Switch MTP device was found.' }
    $result | ConvertTo-Json -Depth 5 -Compress
    exit 0
}
$device = $devices[0]
$result.device_id = "$($device.Path)"
$deviceFolder = $device.GetFolder
$installed = @($deviceFolder.Items() | Where-Object { "$($_.Name)" -match '(?i)^(?:4:\s*)?Installed games$' })
if ($installed.Count -ne 1) {
    $result.message = 'DBI Installed games storage is unavailable. Enable it in DBI MTP Storages.'
    $result | ConvertTo-Json -Depth 5 -Compress
    exit 0
}
$files = New-Object 'System.Collections.Generic.List[object]'
$unidentified = 0
$visited = 0
$limit = 20000
$limited = $false
$installedFolder = $installed[0].GetFolder
foreach ($game in $installedFolder.Items()) {
    $visited++
    if ($visited -gt $limit) { $limited = $true; break }
    if (-not $game.IsFolder) { continue } # Root combined NSPs duplicate the per-game entries.
    if ("$($game.Name)" -match '(?i)^Mods\s*&\s*Cheats$') { continue }
    try { $gameFolder = $game.GetFolder } catch { $unidentified++; continue }
    if ($null -eq $gameFolder) { $unidentified++; continue }
    foreach ($entry in $gameFolder.Items()) {
        $visited++
        if ($visited -gt $limit) { $limited = $true; break }
        $name = "$($entry.Name)"
        if ($entry.IsFolder) {
            if ($name -notmatch '(?i)^Mods\s*&\s*Cheats$') { $unidentified++ }
            continue
        }
        # Windows may hide known extensions in FolderItem.Name. The virtual
        # Shell path still supplies the extension without opening the file.
        if ($name -notmatch '(?i)\.nsp$' -and "$($entry.Path)" -match '(?i)\.nsp$') {
            $name += '.nsp'
        }
        if ($name -match '(?i)\.nsp$') {
            $files.Add([PSCustomObject]@{ folder_name = "$($game.Name)"; file_name = $name })
        } else {
            $unidentified++
        }
    }
    if ($limited) { break }
}
$result.files = @($files.ToArray())
$result.unidentified_files = $unidentified
$result.state = if ($limited -or $unidentified -gt 0) { 'partial' } else { 'ready' }
$result.message = if ($limited) { 'Installed games listing exceeded the item limit.' } elseif ($unidentified -gt 0) {
    'Some entries could not be identified.'
} else { $null }
$result | ConvertTo-Json -Depth 5 -Compress
