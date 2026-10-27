# Aims the Android emulator's virtual-scene camera (synthetic room; no real camera) by holding Alt over the emulator
# window and sending relative mouse moves / WASD keys — the emulator's own camera controls. Used once before recording
# so the app's real scanner faces the QR poster loaded with -virtualscene-poster.
#   powershell -File aim-virtualscene.ps1 -Dx -400 -Dy 0 -Keys "" -Steps 20
param([int]$Dx = 0, [int]$Dy = 0, [string]$Keys = "", [int]$Steps = 20, [int]$KeyMs = 120)
Add-Type @"
using System; using System.Runtime.InteropServices;
public class W {
 [DllImport("user32.dll")] public static extern bool SetForegroundWindow(IntPtr h);
 [DllImport("user32.dll")] public static extern bool GetWindowRect(IntPtr h, out RECT r);
 [DllImport("user32.dll")] public static extern bool SetCursorPos(int x, int y);
 [DllImport("user32.dll")] public static extern void keybd_event(byte vk, byte scan, uint flags, UIntPtr extra);
 [DllImport("user32.dll")] public static extern void mouse_event(uint f, int dx, int dy, uint d, UIntPtr e);
 public struct RECT { public int L, T, R, B; }
}
"@
$p = Get-Process | Where-Object { $_.MainWindowTitle -like "Android Emulator*" } | Select-Object -First 1
if (-not $p) { throw "emulator window not found" }
[W]::SetForegroundWindow($p.MainWindowHandle) | Out-Null
Start-Sleep -Milliseconds 300
$r = New-Object W+RECT; [W]::GetWindowRect($p.MainWindowHandle, [ref]$r) | Out-Null
[W]::SetCursorPos([int](($r.L + $r.R) / 2), [int](($r.T + $r.B) / 2)) | Out-Null
$ALT = 0x12; $UP = 2
[W]::keybd_event($ALT, 0, 0, [UIntPtr]::Zero)
Start-Sleep -Milliseconds 250
for ($i = 0; $i -lt $Steps; $i++) {
  [W]::mouse_event(1, [int]($Dx / $Steps), [int]($Dy / $Steps), 0, [UIntPtr]::Zero)  # MOUSEEVENTF_MOVE (relative)
  Start-Sleep -Milliseconds 25
}
foreach ($c in $Keys.ToCharArray()) {
  $vk = [byte][char]::ToUpper($c)
  [W]::keybd_event($vk, 0, 0, [UIntPtr]::Zero); Start-Sleep -Milliseconds $KeyMs; [W]::keybd_event($vk, 0, $UP, [UIntPtr]::Zero)
  Start-Sleep -Milliseconds 40
}
Start-Sleep -Milliseconds 150
[W]::keybd_event($ALT, 0, $UP, [UIntPtr]::Zero)
"aimed dx=$Dx dy=$Dy keys=$Keys"
