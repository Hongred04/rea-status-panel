<#
  REA 状态自检
  用途：一条命令 / 双击查看 REA 当前是否可用、能做什么。
  数据来源：rea doctor --format json（官方权威）+ WorkBuddy mcp.json 实际路径校验。
  兼容：PowerShell 5.1 与 PowerShell 7。
#>

$ErrorActionPreference = 'SilentlyContinue'
# 不强制改写控制台编码：沿用当前控制台的默认代码页（中文 Windows 为 936），
# 这样双击、pwsh、powershell 5.1、以及系统级 UTF-8 设置下都不会出现乱码。

$okMark = 'OK  '
Write-Host ''
Write-Host ('REA 状态自检   ' + (Get-Date -Format 'yyyy-MM-dd HH:mm')) -ForegroundColor White
Write-Host ('-' * 58) -ForegroundColor DarkGray

# ---------- 状态容器 ----------
$cliOk      = $false
$cliText    = ''
$mcpOk      = $false
$mcpText    = ''
$envOk      = $true
$envText    = ''
$engineOk   = $false
$engineText = ''
$skillOk    = $false
$skillText  = ''

# ---------- 1. 定位 rea ----------
$reaCmd = $null
$reaExe = $null
$reaScript = $null

$found = Get-Command rea -ErrorAction SilentlyContinue
if ($found) { $reaCmd = $found.Source }

if (-not $reaCmd) {
    $verFile = Join-Path $env:USERPROFILE '.workbuddy\binaries\node\versions\current'
    if (Test-Path -LiteralPath $verFile) {
        $ver = (Get-Content -LiteralPath $verFile -Raw).Trim()
        $base = Join-Path $env:USERPROFILE ".workbuddy\binaries\node\versions\$ver"
        $exe = Join-Path $base 'node.exe'
        $js  = Join-Path $base 'node_modules\rea-agents\scripts\rea.mjs'
        if ((Test-Path -LiteralPath $exe) -and (Test-Path -LiteralPath $js)) {
            $reaExe = $exe
            $reaScript = $js
        }
    }
}

function Invoke-Rea {
    param([string[]]$ReaArgs)
    if ($reaCmd) { return (& $reaCmd @ReaArgs 2>$null) }
    if ($reaScript) { return (& $reaExe $reaScript @ReaArgs 2>$null) }
    return $null
}

if (-not $reaCmd -and -not $reaScript) {
    $cliText = '未找到 rea 命令（未安装，或 Node 升级后全局包丢失）'
} else {
    $verText = (Invoke-Rea -ReaArgs @('--version')) -join ''
    $verText = $verText.Trim()
    if ($verText) {
        $cliOk = $true
        $cliText = "rea $verText"
    } else {
        $cliText = '命令存在但无法执行（安装损坏）'
    }
}

# ---------- 2. WorkBuddy 接入（mcp.json 实际路径）----------
$mcpFile = Join-Path $env:USERPROFILE '.workbuddy\mcp.json'
if (-not (Test-Path -LiteralPath $mcpFile)) {
    $mcpText = '未注册（缺少 ~/.workbuddy/mcp.json）'
} else {
    $cfg = Get-Content -LiteralPath $mcpFile -Raw | ConvertFrom-Json
    $srv = $cfg.mcpServers.rea
    if (-not $srv) {
        $mcpText = 'mcp.json 中没有 rea 条目'
    } else {
        $bad = @()
        if ($srv.command) {
            if (-not (Test-Path -LiteralPath $srv.command)) { $bad += $srv.command }
        } else { $bad += 'command 为空' }
        if ($srv.args) {
            foreach ($a in $srv.args) {
                if ($a -like '*.mjs' -or $a -like '*.js' -or $a -like '*.cmd') {
                    if (-not (Test-Path -LiteralPath $a)) { $bad += $a }
                }
            }
        }
        if ($bad.Count -eq 0) {
            $mcpOk = $true
            $mcpText = '已接入，配置路径有效'
        } else {
            $mcpText = '配置指向的路径已失效（通常由 Node 升级引起）'
        }
    }
}

# ---------- 3. 运行环境 + 4. 深度分析引擎（取自 doctor）----------
$doctorJson = Invoke-Rea -ReaArgs @('doctor', '--format', 'json')
$doc = $null
if ($doctorJson) {
    $raw = ($doctorJson -join "`n")
    if ($raw.Trim()) { try { $doc = $raw | ConvertFrom-Json } catch { } }
}

if ($doc) {
    $nodeCheck = $doc.scope_checks | Where-Object { $_.name -eq 'node' } | Select-Object -First 1
    $nv = "$($nodeCheck.details.version)"
    if (-not $nv) { $nv = "$($nodeCheck.detail)" }

    # 按 REA 官方区间自行判定：^22.23.4 / ^24.22.1 / >=26.12.1
    $v = $null
    if ($nv -match '^(\d+)\.(\d+)\.(\d+)') {
        $v = [version]("{0}.{1}.{2}" -f $Matches[1], $Matches[2], $Matches[3])
    }
    $compliant = $false
    if ($v) {
        $mj = $v.Major
        if ($mj -eq 22 -and $v -ge [version]'22.23.4') { $compliant = $true }
        if ($mj -eq 24 -and $v -ge [version]'24.22.1') { $compliant = $true }
        if ($mj -gt 26) { $compliant = $true }
        if ($mj -eq 26 -and $v -ge [version]'26.12.1') { $compliant = $true }
    }
    if ($compliant) {
        $envOk = $true
        $envText = "Node $nv（符合官方要求）"
    } else {
        $envOk = $false
        $envText = "Node $nv，低于官方下限 22.23.4（实测可运行）"
    }

    # 深度分析引擎
    $engineNames = @('hopper', 'ghidra', 'ida-registration', 'jadx', 'kuna-installation')
    $ready = @()
    foreach ($c in $doc.scope_checks) {
        if ($engineNames -contains $c.name -and $c.ok -eq $true) { $ready += $c.name }
    }
    if ($ready.Count -gt 0) {
        $engineOk = $true
        $engineText = '已就绪：' + ($ready -join ', ')
    } else {
        $engineText = '未配置 Hopper / Ghidra / IDA（仅静态分析可用）'
    }
} else {
    $envText = '无法读取 doctor 结果'
    $engineText = '无法判定'
}

# ---------- 5. 配套技能包 ----------
$skillFile = Join-Path $env:USERPROFILE '.workbuddy\skills\reverse-engineer-anything\SKILL.md'
if (Test-Path -LiteralPath $skillFile) {
    $skillOk = $true
    $skillText = 'reverse-engineer-anything 已安装'
} else {
    $skillText = '未安装（REA 工具可用，但缺少分析工作流指令）'
}

# ---------- 输出 ----------
function Show-Row {
    param([string]$Level, [string]$Label, [string]$Text)
    switch ($Level) {
        'ok'   { $mark = '[OK]  '; $color = 'Green' }
        'warn' { $mark = '[WARN]'; $color = 'Yellow' }
        'info' { $mark = '[INFO]'; $color = 'Cyan' }
        default { $mark = '[FAIL]'; $color = 'Red' }
    }
    # 按显示宽度补空格：中文占 2 列，保证各行对齐
    $w = 0
    foreach ($ch in $Label.ToCharArray()) {
        if ([int]$ch -gt 127) { $w += 2 } else { $w += 1 }
    }
    $pad = ' ' * [Math]::Max(0, 12 - $w)
    Write-Host ('  ' + $mark + ' ' + $Label + $pad + $Text) -ForegroundColor $color
}

Show-Row -Level (& { if ($cliOk) { 'ok' } else { 'fail' } })         -Label '命令行'   -Text $cliText
Show-Row -Level (& { if ($mcpOk) { 'ok' } else { 'fail' } })         -Label '接入'     -Text $mcpText
Show-Row -Level (& { if ($envOk) { 'ok' } else { 'warn' } })         -Label '运行环境' -Text $envText
Show-Row -Level (& { if ($engineOk) { 'ok' } else { 'info' } })      -Label '深度引擎' -Text $engineText
Show-Row -Level (& { if ($skillOk) { 'ok' } else { 'fail' } })       -Label '技能包'   -Text $skillText

Write-Host ('-' * 58) -ForegroundColor DarkGray

# ---------- 结论 ----------
if (-not $cliOk) {
    Write-Host '结论：REA 当前不可用。' -ForegroundColor Red
    Write-Host '  修复：npm install -g rea-agents@6.8.0 --omit=optional' -ForegroundColor DarkGray
} elseif (-not $mcpOk) {
    Write-Host '结论：命令行可用，但 WorkBuddy 里调不到 REA。' -ForegroundColor Yellow
    Write-Host '  修复：把 ~/.workbuddy/mcp.json 的路径指向当前 Node 版本目录。' -ForegroundColor DarkGray
} elseif ($engineOk) {
    Write-Host '结论：REA 全功能可用。' -ForegroundColor Green
} else {
    Write-Host '结论：REA 可用（静态分析范围）。' -ForegroundColor Green
    Write-Host '  可做：JS/Electron、.NET、APK、Go/Rust、模型文件、网页与抓包分析' -ForegroundColor DarkGray
    Write-Host '  不可做：需要反编译汇编/伪代码的原生二进制深度分析' -ForegroundColor DarkGray
}

Write-Host ''

# 自检跑完即视为正常结束；仅在 REA 完全不可用时返回失败状态
if (-not $cliOk) { exit 1 }
exit 0
