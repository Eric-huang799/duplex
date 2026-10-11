# filetool.ps1 —— 本地文件读取/编辑/查找/搜索助手
# Duplex 技能包「本地文件操作」专用；由内置模型经 run_skill_script 调用。
# 兼容 Windows PowerShell 5.1。
#
# 用法：
#   filetool.ps1 read  -Path <绝对路径> [-Offset 1] [-Limit 400]
#   filetool.ps1 edit  -Path <绝对路径> -Old <旧文本> -New <新文本> [-All]
#   filetool.ps1 edit  -Spec <任务JSON>    # {"path":"...","old":"...","new":"...","all":false}
#   filetool.ps1 find  -Path <目录> -Pattern <通配符> [-Limit 200]
#   filetool.ps1 grep  -Path <目录> -Pattern <正则> [-Include <通配符>] [-Limit 100]

$ErrorActionPreference = 'Stop'
try { [Console]::OutputEncoding = [System.Text.Encoding]::UTF8 } catch { }

function Fail([string]$msg) {
  [Console]::Out.WriteLine("错误：$msg")
  exit 1
}

# ---------- 参数解析（手动解析：以 '-' 开头的值也会被当作参数值） ----------
$command = ''
$opts = @{}
$flags = @{}
for ($i = 0; $i -lt $args.Count; $i++) {
  $a = [string]$args[$i]
  if ($a -eq '-All') { $flags['all'] = $true; continue }
  if ($a -match '^-([A-Za-z][A-Za-z0-9]*)$') {
    if ($i + 1 -ge $args.Count) { Fail("参数 $a 缺少取值") }
    $opts[$Matches[1].ToLowerInvariant()] = [string]$args[$i + 1]
    $i++
    continue
  }
  if ($command -eq '') { $command = $a; continue }
  Fail("无法识别的参数：$a")
}
if ($command -eq '') { Fail('缺少子命令（支持 read / edit / find / grep）') }

function Opt([string]$name, [string]$default = '') {
  if ($opts.ContainsKey($name)) { return [string]$opts[$name] }
  return $default
}

# ---------- 保护目录黑名单（与 Duplex 应用一致） ----------
$script:blockedRoots = @()
function Initialize-BlockedRoots {
  $homeDir = $env:USERPROFILE
  $roots = @(
    (Join-Path $homeDir '.ssh'),
    (Join-Path $homeDir '.aws'),
    (Join-Path $homeDir '.gnupg'),
    (Join-Path $homeDir '.config'),
    (Join-Path $homeDir '.claude'),
    (Join-Path $homeDir '.codex'),
    (Join-Path $homeDir '.local\share\opencode'),
    (Join-Path $homeDir '.cobrowse'),
    $env:SystemRoot,
    $env:ProgramFiles,
    ${env:ProgramFiles(x86)}
  )
  $script:blockedRoots = @(
    $roots |
      Where-Object { $_ -and ([string]$_).Trim() -ne '' } |
      ForEach-Object { ([System.IO.Path]::GetFullPath($_)).TrimEnd('\').ToLowerInvariant() }
  )
}
Initialize-BlockedRoots

# 逐级解析 reparse point（junction/symlink），避免经链接绕过黑名单
function Get-RealPath([string]$p) {
  try { $full = [System.IO.Path]::GetFullPath($p) } catch { return $null }
  $root = [System.IO.Path]::GetPathRoot($full)
  if (-not $root) { return $full }
  $cur = $root
  $rest = $full.Substring($root.Length)
  foreach ($seg in ($rest -split '\\')) {
    if ($seg -eq '') { continue }
    $cur = Join-Path $cur $seg
    if (Test-Path -LiteralPath $cur) {
      $item = Get-Item -LiteralPath $cur -Force -ErrorAction SilentlyContinue
      if ($item -and (([int]$item.Attributes -band [int][System.IO.FileAttributes]::ReparsePoint) -ne 0)) {
        $t = $item.Target
        if ($t -is [array]) { $t = $t[0] }
        if ($t) {
          if (-not [System.IO.Path]::IsPathRooted($t)) { $t = Join-Path (Split-Path $cur -Parent) $t }
          $cur = [System.IO.Path]::GetFullPath($t)
        }
      }
    }
  }
  return $cur
}

function Test-Blocked([string]$p) {
  $real = Get-RealPath $p
  if (-not $real) { return $true }
  $low = $real.TrimEnd('\').ToLowerInvariant()
  foreach ($b in $script:blockedRoots) {
    if ($low -eq $b) { return $true }
    if ($low.StartsWith($b + '\')) { return $true }
  }
  return $false
}

function Test-ReparsePoint([System.IO.FileSystemInfo]$item) {
  if (-not $item) { return $false }
  return (([int]$item.Attributes -band [int][System.IO.FileAttributes]::ReparsePoint) -ne 0)
}

function Test-BinaryFile([string]$path) {
  try {
    $fs = [System.IO.File]::OpenRead($path)
    try {
      $buf = New-Object byte[] 8192
      $n = $fs.Read($buf, 0, 8192)
    } finally { $fs.Close() }
    for ($i = 0; $i -lt $n; $i++) { if ($buf[$i] -eq 0) { return $true } }
    return $false
  } catch {
    return $true
  }
}

# ---------- read ----------
function Cmd-Read {
  $p = Opt 'path'
  if ($p -eq '') { Fail('read 需要 -Path <绝对路径>') }
  $offset = 1
  $limit = 400
  $o = Opt 'offset'; if ($o -ne '') { $offset = [int]$o }
  $l = Opt 'limit'; if ($l -ne '') { $limit = [int]$l }
  if ($offset -lt 1) { $offset = 1 }
  if ($limit -lt 1) { $limit = 1 }
  if (Test-Blocked $p) { Fail("受保护路径，已拒绝读取：$p") }
  if (-not (Test-Path -LiteralPath $p -PathType Leaf)) { Fail("文件不存在或不是普通文件：$p") }
  $real = Get-RealPath $p
  if (Test-BinaryFile $real) { Fail('疑似二进制文件，已拒绝按文本读取') }

  $cap = 7000
  $out = New-Object System.Collections.Generic.List[string]
  $chars = 0
  $printed = 0
  $lineNo = 0
  $hitCap = $false
  $reader = New-Object System.IO.StreamReader($real, [System.Text.Encoding]::UTF8, $true)
  try {
    while (-not $reader.EndOfStream) {
      $line = $reader.ReadLine()
      $lineNo++
      if ($lineNo -lt $offset) { continue }
      if ($lineNo -ge ($offset + $limit)) { break }
      $s = '{0:D6}| {1}' -f $lineNo, $line
      if (($chars + $s.Length + 1) -gt $cap) { $hitCap = $true; break }
      $out.Add($s)
      $chars += $s.Length + 1
      $printed++
    }
    $hasMore = -not $reader.EndOfStream
  } finally { $reader.Close() }

  if ($printed -eq 0) {
    [Console]::Out.WriteLine('（该范围内没有可读内容）')
    exit 0
  }
  [Console]::Out.WriteLine(($out -join "`n"))
  $end = $offset + $printed - 1
  if ($hitCap -or $hasMore) {
    [Console]::Out.WriteLine("--- 已显示第 $offset-$end 行（还有后续内容，用 -Offset $($end + 1) 继续读）")
  } else {
    [Console]::Out.WriteLine("--- 已显示第 $offset-$end 行（已到文件末尾）")
  }
}

# ---------- edit ----------
function Count-Matches([string]$text, [string]$needle) {
  $count = 0
  $idx = 0
  while ($true) {
    $j = $text.IndexOf($needle, $idx, [System.StringComparison]::Ordinal)
    if ($j -lt 0) { break }
    $count++
    $idx = $j + $needle.Length
  }
  return $count
}

function Get-MatchLineNumbers([string]$text, [string]$needle, [int]$max) {
  $lines = New-Object System.Collections.Generic.List[int]
  $count = 0
  $idx = 0
  while ($count -lt $max) {
    $j = $text.IndexOf($needle, $idx, [System.StringComparison]::Ordinal)
    if ($j -lt 0) { break }
    $ln = 1
    for ($k = 0; $k -lt $j; $k++) { if ($text[$k] -eq "`n") { $ln++ } }
    $lines.Add($ln)
    $count++
    $idx = $j + $needle.Length
  }
  return $lines
}

function Get-TextEncodingForWrite([string]$path) {
  try {
    $fs = [System.IO.File]::OpenRead($path)
    try {
      $b = New-Object byte[] 3
      $n = $fs.Read($b, 0, 3)
    } finally { $fs.Close() }
    if ($n -eq 3 -and $b[0] -eq 0xEF -and $b[1] -eq 0xBB -and $b[2] -eq 0xBF) {
      return (New-Object System.Text.UTF8Encoding($true))
    }
  } catch { }
  return (New-Object System.Text.UTF8Encoding($false))
}

function Cmd-Edit {
  $p = Opt 'path'
  $old = Opt 'old'
  $newProvided = $opts.ContainsKey('new')
  $new = Opt 'new'
  $all = $flags.ContainsKey('all')
  $spec = Opt 'spec'

  if ($spec -ne '') {
    if (Test-Blocked $spec) { Fail("受保护路径，已拒绝：$spec") }
    if (-not (Test-Path -LiteralPath $spec -PathType Leaf)) { Fail("任务文件不存在：$spec") }
    $raw = [System.IO.File]::ReadAllText((Get-RealPath $spec), [System.Text.Encoding]::UTF8)
    $job = $null
    try { $job = $raw | ConvertFrom-Json } catch { Fail('任务文件不是合法 JSON') }
    $p = [string]$job.path
    if ($job.PSObject.Properties.Name -contains 'old') { $old = [string]$job.old }
    if ($job.PSObject.Properties.Name -contains 'new') { $new = [string]$job.new; $newProvided = $true }
    if (($job.PSObject.Properties.Name -contains 'all') -and ($job.all -eq $true)) { $all = $true }
  }

  if ($p -eq '') { Fail('edit 需要 -Path 或 -Spec') }
  if ($old -eq '') { Fail('缺少旧文本 -Old（不能为空）') }
  if (-not $newProvided) { Fail('缺少新文本 -New（如需删除内容请改用 -Spec 模式，new 写成空字符串）') }
  if ($old -eq $new) { Fail('新旧文本相同，无需修改') }
  if (Test-Blocked $p) { Fail("受保护路径，已拒绝修改：$p") }
  if (-not (Test-Path -LiteralPath $p -PathType Leaf)) { Fail("文件不存在：$p") }
  $real = Get-RealPath $p
  if (Test-BinaryFile $real) { Fail('疑似二进制文件，已拒绝修改') }

  $text = [System.IO.File]::ReadAllText($real, [System.Text.Encoding]::UTF8)
  $count = Count-Matches $text $old
  if ($count -eq 0) { Fail('未找到要替换的内容——请先用 read 确认原文（注意空白与换行差异）') }
  if ($count -gt 1 -and (-not $all)) {
    $lines = Get-MatchLineNumbers $text $old 5
    [Console]::Out.WriteLine("错误：要替换的内容在文件中出现 $count 处，不唯一。请扩大上下文使其唯一，或使用 -All 全部替换。")
    [Console]::Out.WriteLine("出现位置（行号，最多列 5 处）：$($lines -join '、')")
    exit 1
  }

  if ($all) {
    $newText = $text.Replace($old, $new)
  } else {
    $j = $text.IndexOf($old, [System.StringComparison]::Ordinal)
    $newText = $text.Substring(0, $j) + $new + $text.Substring($j + $old.Length)
  }
  $enc = Get-TextEncodingForWrite $real
  [System.IO.File]::WriteAllText($real, $newText, $enc)
  [Console]::Out.WriteLine("已修改：$real（替换 $count 处）")
  [Console]::Out.WriteLine('提示：建议重新 read 一次确认修改结果。')
}

# ---------- find ----------
function Cmd-Find {
  $dir = Opt 'path'
  $pattern = Opt 'pattern'
  if ($dir -eq '') { Fail('find 需要 -Path <目录>') }
  if ($pattern -eq '') { Fail('find 需要 -Pattern（文件名通配符，如 *.py）') }
  $limit = 200
  $l = Opt 'limit'; if ($l -ne '') { $limit = [int]$l }
  if ($limit -lt 1) { $limit = 1 }
  if (Test-Blocked $dir) { Fail("受保护目录，已拒绝：$dir") }
  if (-not (Test-Path -LiteralPath $dir -PathType Container)) { Fail("目录不存在：$dir") }
  $root = (Get-RealPath $dir).TrimEnd('\')

  $found = New-Object System.Collections.Generic.List[string]
  $stack = New-Object System.Collections.Stack
  $stack.Push($root)
  while ($stack.Count -gt 0) {
    $cur = [string]$stack.Pop()
    $entries = @()
    try { $entries = Get-ChildItem -LiteralPath $cur -Force -ErrorAction SilentlyContinue } catch { continue }
    foreach ($e in $entries) {
      if (Test-ReparsePoint $e) { continue }
      if ($e.PSIsContainer) {
        if (Test-Blocked $e.FullName) { continue }
        $stack.Push($e.FullName)
      } elseif ($e.Name -like $pattern) {
        if (Test-Blocked $e.FullName) { continue }
        $rel = $e.FullName.Substring($root.Length).TrimStart('\')
        $found.Add($rel)
      }
      if ($found.Count -ge ($limit * 5)) { break }
    }
    if ($found.Count -ge ($limit * 5)) { break }
  }

  $sorted = @($found | Sort-Object)
  if ($sorted.Count -eq 0) {
    [Console]::Out.WriteLine('（未找到匹配的文件）')
    exit 0
  }
  $shown = $sorted
  $note = ''
  if ($sorted.Count -gt $limit) {
    $shown = $sorted[0..($limit - 1)]
    $note = "（共找到 $($sorted.Count) 个，仅显示前 $limit 个，可用 -Limit 调整）"
  }
  [Console]::Out.WriteLine(($shown -join "`n"))
  if ($note -ne '') { [Console]::Out.WriteLine($note) }
}

# ---------- grep ----------
function Cmd-Grep {
  $dir = Opt 'path'
  $pattern = Opt 'pattern'
  if ($dir -eq '') { Fail('grep 需要 -Path <目录>') }
  if ($pattern -eq '') { Fail('grep 需要 -Pattern <正则>') }
  $include = Opt 'include'
  $limit = 100
  $l = Opt 'limit'; if ($l -ne '') { $limit = [int]$l }
  if ($limit -lt 1) { $limit = 1 }
  if (Test-Blocked $dir) { Fail("受保护目录，已拒绝：$dir") }
  if (-not (Test-Path -LiteralPath $dir -PathType Container)) { Fail("目录不存在：$dir") }
  try { $null = [regex]::new($pattern) } catch { Fail("正则表达式无效：$($_.Exception.Message)") }
  $root = (Get-RealPath $dir).TrimEnd('\')

  $cap = 7000
  $results = New-Object System.Collections.Generic.List[string]
  $chars = 0
  $scanned = 0
  $scanLimit = 2000
  $hitCap = $false
  $stack = New-Object System.Collections.Stack
  $stack.Push($root)
  while (($stack.Count -gt 0) -and (-not $hitCap)) {
    $cur = [string]$stack.Pop()
    $entries = @()
    try { $entries = Get-ChildItem -LiteralPath $cur -Force -ErrorAction SilentlyContinue } catch { continue }
    foreach ($e in $entries) {
      if ($hitCap) { break }
      if (Test-ReparsePoint $e) { continue }
      if ($e.PSIsContainer) {
        if (Test-Blocked $e.FullName) { continue }
        $stack.Push($e.FullName)
        continue
      }
      if ($include -ne '' -and ($e.Name -notlike $include)) { continue }
      if (Test-Blocked $e.FullName) { continue }
      if ($e.Length -gt 5MB) { continue }
      if (Test-BinaryFile $e.FullName) { continue }
      $scanned++
      if ($scanned -gt $scanLimit) { $hitCap = $true; break }
      $rel = $e.FullName.Substring($root.Length).TrimStart('\')
      $ln = 0
      try {
        $reader = New-Object System.IO.StreamReader($e.FullName, [System.Text.Encoding]::UTF8, $true)
        try {
          while (-not $reader.EndOfStream) {
            $line = $reader.ReadLine()
            $ln++
            if ($line.Length -gt 0 -and ([regex]::IsMatch($line, $pattern))) {
              $shown = $line.Trim()
              if ($shown.Length -gt 300) { $shown = $shown.Substring(0, 300) + '…' }
              $s = "${rel}:${ln}: $shown"
              if (($chars + $s.Length + 1) -gt $cap) { $hitCap = $true; break }
              $results.Add($s)
              $chars += $s.Length + 1
              if ($results.Count -ge $limit) { $hitCap = $true; break }
            }
          }
        } finally { $reader.Close() }
      } catch { continue }
    }
  }

  if ($results.Count -eq 0) {
    [Console]::Out.WriteLine('（未找到匹配内容）')
    exit 0
  }
  [Console]::Out.WriteLine(($results -join "`n"))
  if ($hitCap) {
    [Console]::Out.WriteLine("--- 结果达到上限或输出已截断（已显示 $($results.Count) 条）。请缩小 -Path/-Include 或调整 -Limit。")
  } else {
    [Console]::Out.WriteLine("--- 共 $($results.Count) 条匹配")
  }
}

# ---------- 分发 ----------
switch ($command.ToLowerInvariant()) {
  'read' { Cmd-Read }
  'edit' { Cmd-Edit }
  'find' { Cmd-Find }
  'grep' { Cmd-Grep }
  default { Fail("未知子命令：$command（支持 read / edit / find / grep）") }
}
exit 0
