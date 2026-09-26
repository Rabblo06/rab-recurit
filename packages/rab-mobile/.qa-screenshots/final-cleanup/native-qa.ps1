param([ValidateSet('Capture','Tap','Inspect')][string]$Action, [string]$Label, [string]$Name)
$adb = 'C:\Users\issac\AppData\Local\Android\Sdk\platform-tools\adb.exe'
$folder = $PSScriptRoot
function Read-CurrentUi {
  $remote = '/sdcard/rab-consistency-' + [DateTimeOffset]::UtcNow.ToUnixTimeMilliseconds() + '.xml'
  $dump = & $adb shell uiautomator dump $remote 2>&1
  if ($dump -notmatch 'dumped to') { throw "No fresh accessibility tree: $dump" }
  & $adb pull $remote "$folder/current.xml" 2>&1 | Out-Null
  & $adb shell rm $remote | Out-Null
  return [xml](Get-Content "$folder/current.xml")
}
if ($Action -eq 'Tap') {
  $tree = Read-CurrentUi
  $node = $tree.SelectNodes('//node') | Where-Object { $_.'content-desc' -eq $Label -or $_.text -eq $Label } | Select-Object -First 1
  if ($null -eq $node) { throw "Label not visible: $Label" }
  $numbers = [regex]::Matches($node.bounds, '\d+') | ForEach-Object { [int]$_.Value }
  & $adb shell input tap ([int](($numbers[0]+$numbers[2])/2)) ([int](($numbers[1]+$numbers[3])/2))
  Write-Output "Tapped $Label"
} elseif ($Action -eq 'Capture') {
  Start-Sleep -Milliseconds 800
  $null = Read-CurrentUi
  & $adb shell screencap -p /sdcard/rab-consistency.png
  & $adb pull /sdcard/rab-consistency.png "$folder/$Name.png"
} else {
  $tree = Read-CurrentUi
  $tree.SelectNodes('//node') | Where-Object { $_.'content-desc' -ne '' } | ForEach-Object { $_.'content-desc' }
}
