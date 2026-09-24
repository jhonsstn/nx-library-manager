$ErrorActionPreference = 'Stop'
[Console]::OutputEncoding = [System.Text.Encoding]::UTF8
$shell = New-Object -ComObject Shell.Application
$root = $shell.Namespace("shell:MyComputerFolder")
if ($null -eq $root) {
    Write-Output "[]"
    exit 0
}
function Get-ExtendedValue($item, [string[]]$keys) {
    foreach ($key in $keys) {
        try {
            $value = $item.ExtendedProperty($key)
            if ($null -ne $value -and "$value" -ne "") {
                return $value
            }
        } catch {}
    }
    return $null
}
function Convert-SizeTextToBytes($value) {
    if ($null -eq $value) {
        return 0
    }
    if ($value -is [int64] -or $value -is [uint64] -or $value -is [int] -or $value -is [uint32] -or $value -is [double] -or $value -is [decimal]) {
        return [int64]$value
    }
    $text = "$value"
    if ($text -match '^\d+$') {
        return [int64]$text
    }
    if ($text -match '([\d\.,]+)\s*(B|KB|MB|GB|TB)') {
        $number = [double]($matches[1].Replace(',', ''))
        switch ($matches[2].ToUpperInvariant()) {
            "B" { return [int64]$number }
            "KB" { return [int64]($number * 1KB) }
            "MB" { return [int64]($number * 1MB) }
            "GB" { return [int64]($number * 1GB) }
            "TB" { return [int64]($number * 1TB) }
        }
    }
    return 0
}
function Get-DetailValue($folder, $item, [string[]]$patterns) {
    for ($index = 0; $index -lt 300; $index++) {
        $header = $folder.GetDetailsOf($null, $index)
        if ([string]::IsNullOrWhiteSpace($header)) {
            continue
        }
        foreach ($pattern in $patterns) {
            if ($header -match $pattern) {
                $value = $folder.GetDetailsOf($item, $index)
                if (-not [string]::IsNullOrWhiteSpace($value)) {
                    return $value
                }
            }
        }
    }
    return $null
}
function Normalize-StorageName($deviceName, $storageName) {
    $name = "$storageName"
    if ($name -match '(?i)\bsd\b|sd card|microsd' -and $name -match '(?i)install') {
        return "SD install"
    }
    if ($name -match '(?i)nand' -and $name -match '(?i)install') {
        return "NAND install"
    }
    return ""
}
$rows = @()
foreach ($device in $root.Items()) {
    $deviceName = "$($device.Name)"
    $devicePath = "$($device.Path)"
    $deviceLooksLikeSwitch = $deviceName -match '(?i)switch|nintendo' -or $devicePath -match '(?i)vid_057e|pid_201d'
    if (-not $deviceLooksLikeSwitch) {
        continue
    }
    $rows += [PSCustomObject]@{ name = ''; device_id = $devicePath }
    $deviceFolder = $null
    try { $deviceFolder = $device.GetFolder } catch {}
    if ($null -eq $deviceFolder) {
        continue
    }
    foreach ($storage in $deviceFolder.Items()) {
        $displayName = Normalize-StorageName $deviceName $storage.Name
        if (-not $displayName) {
            continue
        }
        $free = Get-ExtendedValue $storage @("System.FreeSpace", "System.Storage.FreeSpace", "System.Volume.FreeSpace")
        $total = Get-ExtendedValue $storage @("System.Capacity", "System.Storage.Capacity", "System.Volume.TotalSize", "System.Size")
        if ($null -eq $free) {
            $free = Get-DetailValue $deviceFolder $storage @("(?i)free")
        }
        if ($null -eq $total) {
            $total = Get-DetailValue $deviceFolder $storage @("(?i)total", "(?i)capacity", "(?i)^size$")
        }
        $freeBytes = Convert-SizeTextToBytes $free
        $totalBytes = Convert-SizeTextToBytes $total
        if ($freeBytes -gt 0 -and $totalBytes -gt 0) {
            $rows += [PSCustomObject]@{
                name = $displayName
                free_bytes = $freeBytes
                total_bytes = $totalBytes
                path = "$($storage.Path)"
                device_id = $devicePath
            }
        }
    }
}
$rows | ConvertTo-Json -Compress
