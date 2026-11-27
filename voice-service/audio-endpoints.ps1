# Read-only Windows PnP metadata. Chromium remains the authority for live,
# routable endpoint IDs. Container membership associates USB/Bluetooth devices
# with their audio endpoints without parsing undocumented MMDevice ID formats.
$ErrorActionPreference = 'Stop'
[Console]::OutputEncoding = [System.Text.UTF8Encoding]::new($false)
$devices = @(Get-PnpDevice -PresentOnly)
$containers = @{}
foreach ($device in $devices) {
  if ($device.Class -notin @('AudioEndpoint', 'MEDIA') -and $device.InstanceId -notmatch '^(USB|BTH|BTHENUM|BTHLEDEVICE)\\') { continue }
  $container = (Get-PnpDeviceProperty -InstanceId $device.InstanceId -KeyName 'DEVPKEY_Device_ContainerId' -ErrorAction SilentlyContinue).Data
  if ($container -and $container -ne [Guid]::Empty) {
    $key = $container.ToString()
    if (-not $containers.ContainsKey($key)) { $containers[$key] = @() }
    $containers[$key] += $device
  }
}
$result = foreach ($device in $devices | Where-Object { $_.Class -eq 'AudioEndpoint' -and $_.Status -eq 'OK' }) {
  $container = (Get-PnpDeviceProperty -InstanceId $device.InstanceId -KeyName 'DEVPKEY_Device_ContainerId' -ErrorAction SilentlyContinue).Data
  $peers = if ($container) { @($containers[$container.ToString()]) } else { @() }
  $type = 'unknown'
  if ($device.FriendlyName -match '(?i)\b(Microsoft\s+)?Teams\b') { $type = 'virtual' }
  elseif ($peers.InstanceId -match '^(USB|BTH|BTHENUM|BTHLEDEVICE)\\') { $type = 'external' }
  elseif ($device.FriendlyName -match '(?i)headphone|headset|line[ -]?(in|out)|HDMI|displayport') { $type = 'external' }
  elseif ($peers.InstanceId -match '^HDAUDIO\\') { $type = 'built-in' }
  [PSCustomObject]@{ label = $device.FriendlyName; type = $type }
}
ConvertTo-Json -InputObject @($result) -Compress
