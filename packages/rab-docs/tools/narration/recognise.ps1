# Automated intelligibility check (a proxy, NOT a substitute for a human listening): runs the Windows offline speech
# recogniser over a WAV and prints what it heard, so the transcript can be compared with the narration script.
#   powershell -NoProfile -ExecutionPolicy Bypass -File recognise.ps1 -Wav narration.wav
param([Parameter(Mandatory = $true)][string]$Wav)
$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName System.Speech
$info = [System.Speech.Recognition.SpeechRecognitionEngine]::InstalledRecognizers() | Where-Object { $_.Culture.Name -like 'en-*' } | Select-Object -First 1
if (-not $info) { throw 'No English speech recogniser installed' }
$engine = New-Object System.Speech.Recognition.SpeechRecognitionEngine($info)
$engine.LoadGrammar((New-Object System.Speech.Recognition.DictationGrammar))
$engine.SetInputToWaveFile($Wav)
$words = @()
while ($true) {
  try { $r = $engine.Recognize() } catch { break } # the engine throws once the file is exhausted
  if ($null -eq $r) { continue }
  $words += $r.Text
}
$engine.Dispose()
Write-Output ($words -join ' ')
