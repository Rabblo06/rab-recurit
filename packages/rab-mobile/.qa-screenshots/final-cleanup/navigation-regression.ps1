# adb writes successful transfer summaries to stderr on Windows PowerShell.
# Explicit assertions below throw on missing UI/state.
$ErrorActionPreference = 'Continue'
$env:ANDROID_SERIAL = 'emulator-5556'
$adb = 'C:\Users\issac\AppData\Local\Android\Sdk\platform-tools\adb.exe'
$helper = Join-Path $PSScriptRoot 'native-qa.ps1'
$results = @()
for ($iteration = 1; $iteration -le 3; $iteration++) {
  & $helper -Action Tap -Label "Users`n1"
  & $helper -Action Capture -Name "final-users-$iteration" | Out-Null
  & $adb shell input keyevent 4
  & $helper -Action Tap -Label "Reports`n2"
  & $helper -Action Inspect | Out-Null
  $tree = [xml](Get-Content (Join-Path $PSScriptRoot 'current.xml'))
  $node = $tree.SelectNodes('//node') | Where-Object { $_.'content-desc' -match '^QA Bartender' } | Select-Object -First 1
  if (!$node) { throw 'Report row missing' }
  $b = [regex]::Matches($node.bounds, '\d+') | ForEach-Object { [int]$_.Value }
  & $adb shell input tap ([int](($b[0]+$b[2])/2)) ([int](($b[1]+$b[3])/2))
  & $helper -Action Capture -Name "final-report-$iteration" | Out-Null
  $content = Get-Content (Join-Path $PSScriptRoot 'current.xml') -Raw
  if ($content -notmatch 'Clocked out') { throw 'Completed report did not load' }
  & $helper -Action Tap -Label Offers
  & $helper -Action Capture -Name "final-offers-$iteration" | Out-Null
  $content = Get-Content (Join-Path $PSScriptRoot 'current.xml') -Raw
  if ($content -notmatch 'Sent Shifts') { throw 'Offers tab blank' }
  & $helper -Action Tap -Label Profile
  & $helper -Action Inspect | Out-Null
  $content = Get-Content (Join-Path $PSScriptRoot 'current.xml') -Raw
  if ($content -notmatch 'Log out') { throw 'Profile tab blank' }
  & $helper -Action Tap -Label Home
  & $helper -Action Capture -Name "final-restored-report-$iteration" | Out-Null
  $content = Get-Content (Join-Path $PSScriptRoot 'current.xml') -Raw
  if ($content -notmatch 'Clocked out') { throw 'Nested report stack not restored' }
  & $adb shell input keyevent 4
  Start-Sleep -Milliseconds 400
  & $adb shell input keyevent 4
  Start-Sleep -Milliseconds 400
  $results += [pscustomobject]@{ iteration=$iteration; users=$true; reportDetail=$true; offers=$true; profile=$true; restoredReport=$true; systemBack=$true }
  Write-Output "Native navigation cycle $iteration passed"
}
$results | ConvertTo-Json | Set-Content (Join-Path $PSScriptRoot 'navigation-proof.json')
