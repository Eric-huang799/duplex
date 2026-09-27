# Captures ONLY the Duplex window (maximized, verified foreground, DWM bounds).
# Refuses to capture if the Duplex window cannot be brought to the foreground.
# Usage: pwsh -File capture-window.ps1 -OutPath docs\screenshots\x.png
param(
    [Parameter(Mandatory = $true)][string]$OutPath
)
Add-Type -AssemblyName System.Drawing
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
[WinCap]::ShowWindow($h, 3) | Out-Null   # SW_MAXIMIZE (also restores if minimized)
$ok = $false
for ($i = 0; $i -lt 8; $i++) {
    Start-Sleep -Milliseconds 300
    if ([WinCap]::GetForegroundWindow() -eq $h) { $ok = $true; break }
    # ALT tap unlocks SetForegroundWindow (Windows foreground lock workaround)
    [WinCap]::keybd_event(0x12, 0, 0, [IntPtr]::Zero)
    [WinCap]::keybd_event(0x12, 0, 2, [IntPtr]::Zero)
    [WinCap]::SetForegroundWindow($h) | Out-Null
}
if (-not $ok) {
    Write-Error "Duplex is not foreground (fg=$([WinCap]::GetForegroundWindow())) - ABORTING capture to avoid grabbing another window"
    exit 1
}
Start-Sleep -Milliseconds 900   # let the window finish painting
$extRect = New-Object WinCap+RECT
$hr = [WinCap]::DwmGetWindowAttribute($h, 9, [ref]$extRect, [System.Runtime.InteropServices.Marshal]::SizeOf($extRect))
if ($hr -ne 0) {
    $r2 = New-Object WinCap+RECT
    [WinCap]::GetWindowRect($h, [ref]$r2) | Out-Null
    $extRect = $r2
}
$w = $extRect.Right - $extRect.Left
$hh = $extRect.Bottom - $extRect.Top
if ($w -le 0 -or $hh -le 0) { Write-Error "bad window rect"; exit 1 }
$bmp = New-Object System.Drawing.Bitmap($w, $hh)
$g = [System.Drawing.Graphics]::FromImage($bmp)
$g.CopyFromScreen($extRect.Left, $extRect.Top, 0, 0, $bmp.Size)
$g.Dispose()
$dir = Split-Path -Parent $OutPath
if ($dir -and -not (Test-Path $dir)) { New-Item -ItemType Directory -Force -Path $dir | Out-Null }
$bmp.Save((Resolve-Path -LiteralPath (Split-Path -Parent $OutPath)).Path + "\" + (Split-Path -Leaf $OutPath), [System.Drawing.Imaging.ImageFormat]::Png)
$bmp.Dispose()
Write-Output "captured: $OutPath ($w x $hh)"
