# Records ONLY the Duplex window rectangle to an MP4 (verified foreground, DWM bounds).
# Usage:
#   pwsh -File record-window.ps1 -OutPath rec.mp4 -DurationSec 30     # timed recording
#   pwsh -File record-window.ps1 -OutPath rec.mp4                     # until Ctrl+C
param(
    [Parameter(Mandatory = $true)][string]$OutPath,
    [int]$Fps = 30,
    [int]$DurationSec = 0
)
Add-Type @"
using System;
using System.Runtime.InteropServices;
public class WinCap {
    [DllImport("user32.dll")] public static extern bool SetProcessDPIAware();
    [DllImport("user32.dll")] public static extern bool GetWindowRect(IntPtr hWnd, out RECT rect);
    [DllImport("user32.dll")] public static extern bool SetForegroundWindow(IntPtr hWnd);
    [DllImport("user32.dll")] public static extern IntPtr GetForegroundWindow();
    [DllImport("user32.dll")] public static extern bool ShowWindow(IntPtr hWnd, int nCmdShow);
    [DllImport("user32.dll")] public static extern void keybd_event(byte bVk, byte bScan, uint dwFlags, IntPtr dwExtraInfo);
    [DllImport("dwmapi.dll")] public static extern int DwmGetWindowAttribute(IntPtr hwnd, int attr, out RECT pvAttribute, int cbAttribute);
    [StructLayout(LayoutKind.Sequential)] public struct RECT { public int Left, Top, Right, Bottom; }
}
"@
[WinCap]::SetProcessDPIAware() | Out-Null
$proc = Get-Process | Where-Object { ($_.ProcessName -eq 'electron' -or $_.ProcessName -eq 'Duplex') -and $_.MainWindowTitle -eq 'Duplex' } | Select-Object -First 1
if (-not $proc) { Write-Error "no Duplex window found"; exit 1 }
$h = $proc.MainWindowHandle
if ($h -eq 0) { Write-Error "Duplex has no main window handle"; exit 1 }
[WinCap]::ShowWindow($h, 3) | Out-Null   # SW_MAXIMIZE: ext bounds == work area, no shadow/desktop bleed
$ok = $false
for ($i = 0; $i -lt 8; $i++) {
    Start-Sleep -Milliseconds 300
    if ([WinCap]::GetForegroundWindow() -eq $h) { $ok = $true; break }
    [WinCap]::keybd_event(0x12, 0, 0, [IntPtr]::Zero)
    [WinCap]::keybd_event(0x12, 0, 2, [IntPtr]::Zero)
    [WinCap]::SetForegroundWindow($h) | Out-Null
}
if (-not $ok) {
    Write-Error "Duplex is not foreground (fg=$([WinCap]::GetForegroundWindow())) - ABORTING recording"
    exit 1
}
Start-Sleep -Milliseconds 1000   # let the maximize animation settle
$rect = New-Object WinCap+RECT
$hr = [WinCap]::DwmGetWindowAttribute($h, 9, [ref]$rect, [System.Runtime.InteropServices.Marshal]::SizeOf($rect))
if ($hr -ne 0) { [WinCap]::GetWindowRect($h, [ref]$rect) | Out-Null }
$x = $rect.Left; $y = $rect.Top
$w = $rect.Right - $rect.Left
$hh = $rect.Bottom - $rect.Top
if ($w % 2) { $w-- }
if ($hh % 2) { $hh-- }
$dir = Split-Path -Parent $OutPath
if ($dir -and -not (Test-Path $dir)) { New-Item -ItemType Directory -Force -Path $dir | Out-Null }
$ff = @('-y', '-f', 'gdigrab', '-framerate', "$Fps", '-offset_x', "$x", '-offset_y', "$y",
    '-video_size', "${w}x${hh}", '-draw_mouse', '1', '-i', 'desktop',
    '-c:v', 'libx264', '-preset', 'veryfast', '-crf', '18', '-pix_fmt', 'yuv420p')
if ($DurationSec -gt 0) { $ff += @('-t', "$DurationSec") }
$ff += @($OutPath)
Write-Output "recording: $OutPath (${w}x${hh} @ ${Fps}fps, region $x,$y)"
& ffmpeg @ff
if ($LASTEXITCODE -ne 0) { Write-Error "ffmpeg failed with $LASTEXITCODE"; exit 1 }
Write-Output "done: $OutPath"
