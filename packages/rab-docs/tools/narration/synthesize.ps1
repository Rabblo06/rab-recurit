# Local, offline narration synthesis for documentation tutorials (Windows SAPI 5 voices that ship with Windows).
# Nothing is sent to any service; no account, key or download is needed. Scripts contain only authored tutorial text
# about fictional demo data, never real Staff data.
#
#   powershell -NoProfile -ExecutionPolicy Bypass -File synthesize.ps1 -Script scripts/dashboard-tour.json -OutDir <dir>
#
# Writes <OutDir>/<segment id>.wav (22.05 kHz, 16-bit, mono) and <OutDir>/segments.json [{id,text,file,seconds}].
param(
  [Parameter(Mandatory = $true)][string]$Script,
  [Parameter(Mandatory = $true)][string]$OutDir
)
$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName System.Speech
$spec = Get-Content -Raw -Encoding UTF8 $Script | ConvertFrom-Json
New-Item -ItemType Directory -Force $OutDir | Out-Null
$synth = New-Object System.Speech.Synthesis.SpeechSynthesizer
$voice = $spec.voice
if (-not ($synth.GetInstalledVoices() | Where-Object { $_.VoiceInfo.Name -eq $voice -and $_.Enabled })) { throw "Voice not installed: $voice" }
$synth.SelectVoice($voice)
$synth.Rate = [int]$spec.rate
$synth.Volume = 100
$format = New-Object System.Speech.AudioFormat.SpeechAudioFormatInfo(22050, [System.Speech.AudioFormat.AudioBitsPerSample]::Sixteen, [System.Speech.AudioFormat.AudioChannel]::Mono)
# Pronunciation fixes: spoken form only — captions and transcripts keep the on-screen spelling.
$say = @{}
if ($spec.pronounce) { $spec.pronounce.PSObject.Properties | ForEach-Object { $say[$_.Name] = $_.Value } }
$out = @()
foreach ($seg in $spec.segments) {
  $file = Join-Path $OutDir ($seg.id + '.wav')
  $text = [string]$seg.text
  foreach ($k in $say.Keys) { $text = $text -replace [regex]::Escape($k), $say[$k] }
  $synth.SetOutputToWaveFile($file, $format)
  $synth.Speak($text)
  $synth.SetOutputToNull()
  $bytes = (Get-Item $file).Length - 44
  $out += [pscustomobject]@{ id = $seg.id; text = [string]$seg.text; file = ($seg.id + '.wav'); seconds = [math]::Round($bytes / (22050 * 2), 3) }
}
$synth.Dispose()
[System.IO.File]::WriteAllText((Join-Path $OutDir 'segments.json'), (ConvertTo-Json -InputObject @($out) -Depth 3), (New-Object System.Text.UTF8Encoding($false)))
Write-Output ("synthesized {0} segment(s) with '{1}' -> {2}" -f $out.Count, $voice, $OutDir)
