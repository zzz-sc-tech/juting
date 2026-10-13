<#
.SYNOPSIS
    句听 JuTing 本地版托盘 UI（PowerShell 5.1 + NotifyIcon 实现）
.DESCRIPTION
    本脚本只负责「托盘图标 + 右键菜单 + 气泡提示」，不启动也不停止任何服务。
    它与 Node 单文件启动器之间仅通过两个 JSON 文件协作，不握手、不起服务、不读 stdin：

    1) 状态文件（托盘只读，Node 只写）：
       temp/runtime/launcher-status.json
       字段：state(starting/running/stopping/stopped/error)、tooltip、message、
             error、balloon({id,title,text})、pid、exePath、autostart、ports
       读取失败 / JSON 解析失败一律当「没有状态」，静默重试，绝不弹错、绝不退出。
       balloon 按 id 去重，同一个 id 只弹一次。

    2) 命令文件（托盘只写，Node 只读并消费）：
       temp/runtime/launcher-cmd.json
       形如 {"action":"stop|focus","ts":"..."}；开机自启为
       {"action":"autostart","value":true|false}；重启为 {"action":"restart"}。
       写入采用原子写（先写 .tmp 再替换目标），写完由 Node 删除。

    行为要点：
    - 每 500ms 轮询状态文件，更新 tooltip / 弹气泡 / 跟随菜单勾选态；
    - 左键单击打开学习端，右键弹出菜单；
    - running 态下 pid 进程连续 10 秒不存在判定启动器意外停止（气泡 + tooltip 变更）；
    - 停止并退出先下发 stop 命令并等待 state=stopped（最多 40 秒），超时走 stop-all 兜底；
    - 整个主体 try/catch 包裹，任何单次轮询异常只写日志后继续，任何情况下不许闪退。
.PARAMETER StatusPath
    状态文件路径（Node 只写、托盘只读）。默认取仓库根 temp/runtime/launcher-status.json
.PARAMETER CmdPath
    命令文件路径（托盘只写、Node 只读）。默认取仓库根 temp/runtime/launcher-cmd.json
.PARAMETER IconPath
    托盘图标 .ico 路径；不存在时退到系统默认 Application 图标
.PARAMETER LogPath
    托盘自身诊断日志（追加写，每次动作一行，排错用）
.EXAMPLE
    powershell -NoProfile -ExecutionPolicy Bypass -WindowStyle Hidden -File scripts/local/tray-ui.ps1 `
      -StatusPath temp/runtime/launcher-status.json -CmdPath temp/runtime/launcher-cmd.json `
      -IconPath docs/images/juting.ico -LogPath temp/runtime/logs/tray.log
.NOTES
    文件必须以 UTF-8 with BOM 保存，否则 PowerShell 5.1 会把中文按 GBK 解析成乱码。
    退出前务必 $icon.Visible=$false; $icon.Dispose()，否则系统托盘会残留幽灵图标。
#>
[CmdletBinding()]
param(
    # 状态文件：相对路径基于当前工作目录解析
    [string]$StatusPath = (Join-Path $PSScriptRoot '..\..\temp\runtime\launcher-status.json'),
    # 命令文件：托盘只写，Node 只读并消费
    [string]$CmdPath = (Join-Path $PSScriptRoot '..\..\temp\runtime\launcher-cmd.json'),
    # 托盘图标，缺失时退到 SystemIcons::Application
    [string]$IconPath = (Join-Path $PSScriptRoot '..\..\docs\images\juting.ico'),
    # 托盘诊断日志
    [string]$LogPath = (Join-Path $PSScriptRoot '..\..\temp\runtime\logs\tray.log')
)

# 统一让非终止错误也抛异常，配合细粒度 try/catch 使用，问题早暴露但不闪退
$ErrorActionPreference = 'Stop'

# ===================== 全局状态（脚本作用域） =====================
$script:StatusPath = $StatusPath
$script:CmdPath = $CmdPath
$script:IconPath = $IconPath
$script:LogPath = $LogPath

$script:WebUrl = 'http://127.0.0.1:8101'    # 学习端默认地址（若 status.ports.web 存在则跟随）
$script:AdminUrl = 'http://127.0.0.1:8102'  # 管理后台默认地址（若 status.ports.admin 存在则跟随）

$script:notifyIcon = $null      # NotifyIcon 本体
$script:timer = $null           # 500ms 轮询计时器
$script:contextMenu = $null     # 右键菜单
$script:menuAuto = $null        # 「开机自动启动」菜单项（勾选态跟随 status.autostart）
$script:menuRestart = $null     # 「重新启动」菜单项（仅 error 态可见）

$script:lastState = $null       # 上一次读到的 state，用于「状态变化」记日志
$script:lastBalloonId = $null   # 上一次弹过的 balloon.id，用于按 id 去重
$script:missingTicks = 0        # running 态下 pid 不存在的连续轮询次数（20 次 = 10 秒）
$script:crashed = $false        # 是否已判定启动器意外停止
$script:stopRequested = $false  # 用户是否点了「停止并退出」
$script:stopDeadline = [DateTime]::MinValue  # 等待 state=stopped 的超时时刻（40 秒）

# ===================== 基础工具函数 =====================

# 相对路径基于当前工作目录补全为绝对路径，避免日志/命令写错位置
function Resolve-FullPath {
    param([string]$Path)
    if ([string]::IsNullOrWhiteSpace($Path)) { return $Path }
    if ([System.IO.Path]::IsPathRooted($Path)) { return $Path }
    return [System.IO.Path]::GetFullPath([System.IO.Path]::Combine((Get-Location).Path, $Path))
}

# 诊断日志：追加写，每次动作一行；写失败只能吞掉，绝不能因此中断托盘
function Write-TrayLog {
    param(
        [Parameter(Mandatory = $true)]
        [AllowEmptyString()]
        [string]$Message
    )
    $level = 'INFO'
    if ($Message.StartsWith('⚠')) { $level = 'WARN' }
    $line = '{0} [{1}] {2}' -f (Get-Date).ToString('yyyy-MM-dd HH:mm:ss'), $level, $Message
    try {
        [System.IO.File]::AppendAllText($script:LogPath, $line + "`r`n", (New-Object System.Text.UTF8Encoding($false)))
    } catch {
        # 日志通道本身失败时无计可施，静默跳过
    }
}

# 读状态文件：任何失败（不存在 / 正在写 / JSON 不完整）都返回 $null，调用方按「没有状态」静默处理
function Read-LauncherStatus {
    try {
        if (-not (Test-Path -LiteralPath $script:StatusPath)) { return $null }
        # 以 ReadWrite 共享打开，避免 Node 持有写句柄时读取被拒
        $fs = [System.IO.File]::Open($script:StatusPath, [System.IO.FileMode]::Open, [System.IO.FileAccess]::Read, [System.IO.FileShare]::ReadWrite)
        try {
            $sr = New-Object System.IO.StreamReader($fs, [System.Text.Encoding]::UTF8)
            try { $raw = $sr.ReadToEnd() } finally { $sr.Dispose() }
        } finally {
            $fs.Dispose()
        }
        if ([string]::IsNullOrWhiteSpace($raw)) { return $null }
        $obj = $raw | ConvertFrom-Json
        return $obj
    } catch {
        # 撞上半写文件 / JSON 解析失败：一律当没有状态，静默重试
        return $null
    }
}

# 写命令文件：原子写（先 .tmp 再替换），无 BOM UTF-8，供 Node 侧直接 JSON.parse
function Send-LauncherCommand {
    param(
        [Parameter(Mandatory = $true)][string]$Action,
        [bool]$Value,
        [switch]$IncludeValue
    )
    try {
        $payload = [ordered]@{ action = $Action; ts = (Get-Date).ToString('s') }
        if ($IncludeValue) { $payload['value'] = $Value }
        $json = $payload | ConvertTo-Json -Compress
        $tmp = "$script:CmdPath.tmp"
        [System.IO.File]::WriteAllText($tmp, $json, (New-Object System.Text.UTF8Encoding($false)))
        if (Test-Path -LiteralPath $script:CmdPath) {
            # Replace 是真正的原子替换；失败时退回复制 + 删除
            try {
                [System.IO.File]::Replace($tmp, $script:CmdPath, $null)
            } catch {
                [System.IO.File]::Copy($tmp, $script:CmdPath, $true)
                if (Test-Path -LiteralPath $tmp) { [System.IO.File]::Delete($tmp) }
            }
        } else {
            [System.IO.File]::Move($tmp, $script:CmdPath)
        }
        Write-TrayLog "已写命令文件：$json"
    } catch {
        Write-TrayLog "⚠ 写命令文件失败（action=$Action）：$_"
    }
}

# ===================== 托盘表现相关函数 =====================

# 加载托盘图标：优先 IconPath，失败或不存在则退到系统默认图标
function Load-TrayIcon {
    param([string]$Path)
    try {
        if ($Path -and (Test-Path -LiteralPath $Path)) {
            $ic = New-Object System.Drawing.Icon($Path)
            Write-TrayLog "已加载托盘图标：$Path"
            return $ic
        }
    } catch {
        Write-TrayLog "⚠ 加载图标 $Path 失败，改用系统默认图标：$_"
    }
    Write-TrayLog '未提供图标或图标不可用，使用系统默认 Application 图标'
    return [System.Windows.Forms.SystemIcons]::Application
}

# 设置提示文字（NotifyIcon.Text 上限 63 字符，超长会抛异常，需截断；空串同样非法）
function Set-Tooltip {
    param([string]$Text)
    try {
        if ([string]::IsNullOrWhiteSpace($Text)) { $Text = '句听' }
        if ($Text.Length -gt 63) { $Text = $Text.Substring(0, 63) }
        if ($script:notifyIcon.Text -ne $Text) {
            $script:notifyIcon.Text = $Text
        }
    } catch {
        Write-TrayLog "⚠ 设置托盘提示文字异常：$_"
    }
}

# 弹气泡（title/text 有长度上限，超长截断）；写入单行化后的日志
function Show-Balloon {
    param(
        [string]$Title,
        [string]$Text,
        [string]$Kind = 'Info'
    )
    try {
        if ([string]::IsNullOrWhiteSpace($Title)) { $Title = '句听' }
        if ($null -eq $Text) { $Text = '' }
        if ($Title.Length -gt 63) { $Title = $Title.Substring(0, 63) }
        if ($Text.Length -gt 255) { $Text = $Text.Substring(0, 255) }
        $tipIcon = [System.Windows.Forms.ToolTipIcon]::Info
        if ($Kind -eq 'Warning') { $tipIcon = [System.Windows.Forms.ToolTipIcon]::Warning }
        $script:notifyIcon.ShowBalloonTip(5000, $Title, $Text, $tipIcon)
        Write-TrayLog ('气泡：[{0}] {1}' -f $Title, ($Text -replace "\r?\n", ' / '))
    } catch {
        Write-TrayLog "⚠ 显示气泡异常：$_"
    }
}

# 打开网址：失败只记日志，绝不崩溃（例如服务未起来时浏览器打不开）
function Open-Url {
    param([string]$Url)
    try {
        Start-Process $Url
        Write-TrayLog "已打开网址：$Url"
    } catch {
        Write-TrayLog "⚠ 打开网址失败（$Url）：$_"
    }
}

# 在桌面创建「句听.lnk」：优先 status.exePath，缺失退到 IconPath 旁边的 句听.exe
function New-DesktopShortcut {
    try {
        $target = ''
        $status = Read-LauncherStatus
        if ($null -ne $status -and $null -ne $status.exePath -and [string]$status.exePath -ne '') {
            $target = [string]$status.exePath
        }
        if (-not $target) {
            $target = Join-Path (Split-Path -Parent $script:IconPath) '句听.exe'
        }
        $desktop = [Environment]::GetFolderPath('Desktop')
        if (-not $desktop) { $desktop = Join-Path $env:USERPROFILE 'Desktop' }
        $lnkPath = Join-Path $desktop '句听.lnk'
        $ws = New-Object -ComObject WScript.Shell
        try {
            $lnk = $ws.CreateShortcut($lnkPath)
            $lnk.TargetPath = $target
            if (Split-Path -Parent $target) { $lnk.WorkingDirectory = Split-Path -Parent $target }
            if (Test-Path -LiteralPath $script:IconPath) { $lnk.IconLocation = $script:IconPath }
            $lnk.Description = '句听 JuTing 本地学习软件'
            $lnk.Save()
        } finally {
            if ($null -ne $ws) { [System.Runtime.InteropServices.Marshal]::ReleaseComObject($ws) | Out-Null }
        }
        Write-TrayLog "已在桌面创建快捷方式：$lnkPath -> $target"
        Show-Balloon '句听' '已在桌面创建快捷方式' 'Info'
    } catch {
        Write-TrayLog "⚠ 创建桌面快捷方式失败：$_"
    }
}

# 兜底：直接跑 stop-all.mjs 强停本机句听实例（等待其结束）
function Invoke-StopAllFallback {
    try {
        $repoRoot = (Resolve-Path (Join-Path $PSScriptRoot '..' '..')).Path
        $nodeExe = Join-Path $repoRoot 'temp\runtime\node\node.exe'
        if (-not (Test-Path -LiteralPath $nodeExe)) {
            # 便携 node 不在时退到系统 PATH 里的 node
            $nodeExe = 'node'
        }
        $stopScript = Join-Path $PSScriptRoot 'stop-all.mjs'
        if (-not (Test-Path -LiteralPath $stopScript)) {
            Write-TrayLog '⚠ stop-all 兜底跳过：stop-all.mjs 不存在'
            return
        }
        Write-TrayLog "兜底：执行 $nodeExe `"$stopScript`""
        Start-Process -FilePath $nodeExe -ArgumentList "`"$stopScript`"" -WorkingDirectory $repoRoot -Wait -WindowStyle Hidden
        Write-TrayLog '兜底：stop-all.mjs 已执行完毕'
    } catch {
        Write-TrayLog "⚠ stop-all 兜底执行异常：$_"
    }
}

# 清理托盘资源：必须先置 Visible=$false 再 Dispose，否则图标残留幽灵
function Cleanup-TrayIcon {
    try { if ($null -ne $script:timer) { $script:timer.Stop() } } catch {}
    try {
        if ($null -ne $script:notifyIcon) {
            $script:notifyIcon.Visible = $false
            $script:notifyIcon.Dispose()
            $script:notifyIcon = $null
        }
    } catch {}
}

# 正常退出：记原因 -> 清理图标 -> 结束消息循环
function Exit-Tray {
    param([string]$Reason)
    try {
        Write-TrayLog "托盘退出：$Reason"
    } catch {}
    Cleanup-TrayIcon
    try { [System.Windows.Forms.Application]::Exit() } catch {}
}

# ===================== 菜单与轮询逻辑 =====================

function New-TrayMenuItem {
    param(
        [Parameter(Mandatory = $true)][string]$Text,
        [scriptblock]$OnClick
    )
    $item = New-Object System.Windows.Forms.ToolStripMenuItem
    $item.Text = $Text
    if ($OnClick) { $item.Add_Click($OnClick) }
    return $item
}

# 构建右键菜单；菜单项点击事件内部一律 try/catch，写命令文件失败不影响托盘
function Build-ContextMenu {
    $menu = New-Object System.Windows.Forms.ContextMenuStrip

    $mOpenWeb = New-TrayMenuItem '打开学习端' {
        try {
            Write-TrayLog '菜单：打开学习端'
            Open-Url $script:WebUrl
        } catch {
            Write-TrayLog "⚠ 菜单：打开学习端 异常：$_"
        }
    }

    $mOpenAdmin = New-TrayMenuItem '打开管理后台' {
        try {
            Write-TrayLog '菜单：打开管理后台'
            Open-Url $script:AdminUrl
        } catch {
            Write-TrayLog "⚠ 菜单：打开管理后台 异常：$_"
        }
    }

    $mViewLog = New-TrayMenuItem '查看日志' {
        try {
            $logDir = Split-Path -Parent $script:LogPath
            if ($logDir -and -not (Test-Path -LiteralPath $logDir)) {
                New-Item -ItemType Directory -Path $logDir -Force | Out-Null
            }
            Start-Process explorer.exe -ArgumentList "`"$logDir`""
            Write-TrayLog "菜单：查看日志（$logDir）"
        } catch {
            Write-TrayLog "⚠ 菜单：查看日志 异常：$_"
        }
    }

    $mSep1 = New-Object System.Windows.Forms.ToolStripSeparator

    # 开机自动启动：勾选态跟随 status.autostart；点击不直接改注册表，只下发命令由 Node 修改
    $mAuto = New-TrayMenuItem '开机自动启动'
    $mAuto.CheckOnClick = $true
    $mAuto.Add_Click({
        param($sender, $e)
        try {
            # CheckOnClick 模式下进入本事件时 Checked 已是点击后的值
            $val = [bool]$sender.Checked
            Send-LauncherCommand -Action 'autostart' -Value $val -IncludeValue
            Write-TrayLog "菜单：开机自动启动 -> $val（命令已下发，注册表由启动器修改，勾选态跟随 status.autostart）"
        } catch {
            Write-TrayLog "⚠ 菜单：开机自动启动 异常：$_"
        }
    })
    $script:menuAuto = $mAuto

    $mShortcut = New-TrayMenuItem '创建桌面快捷方式' {
        try {
            Write-TrayLog '菜单：创建桌面快捷方式'
            New-DesktopShortcut
        } catch {
            Write-TrayLog "⚠ 菜单：创建桌面快捷方式 异常：$_"
        }
    }

    $mSep2 = New-Object System.Windows.Forms.ToolStripSeparator

    # 重新启动：仅 state=error 时可见（由 Update-MenuStates 控制）
    $mRestart = New-TrayMenuItem '重新启动' {
        try {
            Send-LauncherCommand -Action 'restart'
            Set-Tooltip '句听 · 重启中…'
            Write-TrayLog '菜单：重新启动（命令已下发）'
        } catch {
            Write-TrayLog "⚠ 菜单：重新启动 异常：$_"
        }
    }
    $mRestart.Visible = $false
    $script:menuRestart = $mRestart

    # 停止并退出：先下发 stop 并等待 state=stopped（40 秒），超时或已崩溃则走 stop-all 兜底
    $mStop = New-TrayMenuItem '停止并退出' {
        try {
            if ($script:crashed) {
                Write-TrayLog '菜单：停止并退出（启动器已崩溃，直接执行 stop-all 兜底）'
                Invoke-StopAllFallback
                Exit-Tray '用户选择停止并退出（崩溃兜底 stop-all 后退出）'
                return
            }
            Send-LauncherCommand -Action 'stop'
            $script:stopRequested = $true
            $script:stopDeadline = (Get-Date).AddSeconds(40)
            Set-Tooltip '句听 · 停止中…'
            Write-TrayLog '菜单：停止并退出（已下发 stop，等待 state=stopped，最多 40 秒）'
        } catch {
            Write-TrayLog "⚠ 菜单：停止并退出 异常：$_"
        }
    }

    $null = $menu.Items.Add($mOpenWeb)
    $null = $menu.Items.Add($mOpenAdmin)
    $null = $menu.Items.Add($mViewLog)
    $null = $menu.Items.Add($mSep1)
    $null = $menu.Items.Add($mAuto)
    $null = $menu.Items.Add($mShortcut)
    $null = $menu.Items.Add($mSep2)
    $null = $menu.Items.Add($mRestart)
    $null = $menu.Items.Add($mStop)

    # 菜单即将弹出时刷新一次勾选态与 error 专属项，交互更即时
    $menu.Add_Opening({
        try {
            Update-MenuStates (Read-LauncherStatus)
        } catch {
            Write-TrayLog "⚠ 菜单 Opening 刷新异常：$_"
        }
    })

    $script:contextMenu = $menu
}

# 菜单勾选态 / error 专属项跟随状态文件
function Update-MenuStates {
    param($Status)
    try {
        if ($null -ne $Status -and $null -ne $Status.autostart) {
            $want = [System.Convert]::ToBoolean($Status.autostart)
            if ($null -ne $script:menuAuto -and $script:menuAuto.Checked -ne $want) {
                $script:menuAuto.Checked = $want
            }
        }
        $err = ($null -ne $Status -and $null -ne $Status.state -and [string]$Status.state -eq 'error')
        if ($null -ne $script:menuRestart -and $script:menuRestart.Visible -ne $err) {
            $script:menuRestart.Visible = $err
        }
    } catch {
        Write-TrayLog "⚠ 更新菜单状态异常：$_"
    }
}

# 每 500ms 的轮询：读状态 -> 更新 tooltip/气泡/菜单 -> 崩溃检测 -> 退出判定
function On-PollTick {
    try {
        $status = Read-LauncherStatus
        if ($null -eq $status) {
            # 没有可用状态：图标继续显示，静默重试；顺便清零崩溃累计避免误判
            $script:missingTicks = 0
            return
        }

        $state = ''
        if ($null -ne $status.state) { $state = [string]$status.state }

        # 端口跟随（Node 是唯一真相源，缺省保持 8101/8102）
        if ($null -ne $status.ports) {
            if ($null -ne $status.ports.web) { $script:WebUrl = "http://127.0.0.1:$($status.ports.web)" }
            if ($null -ne $status.ports.admin) { $script:AdminUrl = "http://127.0.0.1:$($status.ports.admin)" }
        }

        # state 变化时记一行日志（含 message 摘要），避免刷屏
        if ($state -ne $script:lastState) {
            $msg = ''
            if ($null -ne $status.message) { $msg = [string]$status.message }
            $tail = ''
            if ($msg) { $tail = " | $msg" }
            Write-TrayLog "状态变化：$($script:lastState) -> $state$tail"
            $script:lastState = $state
        }

        # tooltip 优先级：停止中 > 崩溃 > 启动失败 > status.tooltip > 句听
        $tip = '句听'
        if ($null -ne $status.tooltip -and [string]$status.tooltip -ne '') { $tip = [string]$status.tooltip }
        if ($state -eq 'error') { $tip = '句听 · 启动失败' }
        if ($script:crashed) { $tip = '句听 · 未运行' }
        if ($script:stopRequested -and $state -ne 'stopped') { $tip = '句听 · 停止中…' }
        Set-Tooltip $tip

        # 菜单勾选态 / error 专属项
        Update-MenuStates $status

        # 气泡：balloon.id 变化才弹，同一个 id 只弹一次；error 态用 Warning 图标
        if ($null -ne $status.balloon) {
            $bid = ''
            if ($null -ne $status.balloon.id) { $bid = [string]$status.balloon.id }
            if ($bid -ne '' -and $bid -ne $script:lastBalloonId) {
                $script:lastBalloonId = $bid
                $btitle = '句听'
                if ($null -ne $status.balloon.title -and [string]$status.balloon.title -ne '') { $btitle = [string]$status.balloon.title }
                $btext = ''
                if ($null -ne $status.balloon.text) { $btext = [string]$status.balloon.text }
                $kind = 'Info'
                if ($state -eq 'error') { $kind = 'Warning' }
                Show-Balloon $btitle $btext $kind
            }
        }

        # 崩溃检测：running 态下 pid 对应进程连续 10 秒（20 次轮询）不存在
        if ($state -eq 'running' -and -not $script:stopRequested) {
            $pidNum = 0
            if ($null -ne $status.pid) { $pidNum = [int]$status.pid }
            $alive = $false
            if ($pidNum -gt 0) {
                $proc = $null
                try { $proc = Get-Process -Id $pidNum -ErrorAction Stop } catch { $proc = $null }
                $alive = ($null -ne $proc)
            }
            if ($alive) {
                $script:missingTicks = 0
                if ($script:crashed) {
                    $script:crashed = $false
                    Write-TrayLog '启动器进程已恢复（PID 再次出现），取消崩溃标记'
                }
            } else {
                $script:missingTicks++
                if ($script:missingTicks -ge 20 -and -not $script:crashed) {
                    $script:crashed = $true
                    Write-TrayLog "⚠ 启动器进程（PID $pidNum）连续 10 秒不存在，判定为意外停止"
                    Show-Balloon '句听' '启动器意外停止' 'Warning'
                }
            }
        } else {
            $script:missingTicks = 0
        }

        # 退出判定 1：状态机已停止，托盘随之退出
        if ($state -eq 'stopped') {
            Exit-Tray '检测到 state=stopped，托盘退出'
            return
        }
        # 退出判定 2：用户点了停止且启动器已崩溃，直接兜底
        if ($script:stopRequested -and $script:crashed) {
            Invoke-StopAllFallback
            Exit-Tray '用户选择停止并退出（启动器已崩溃，stop-all 兜底后退出）'
            return
        }
        # 退出判定 3：等待 state=stopped 超时（40 秒），执行 stop-all 兜底
        if ($script:stopRequested -and (Get-Date) -gt $script:stopDeadline) {
            Write-TrayLog '⚠ 等待 state=stopped 超时（40 秒），执行 stop-all 兜底'
            Invoke-StopAllFallback
            Exit-Tray '停止等待超时，stop-all 兜底后退出'
            return
        }
    } catch {
        # 任何单次轮询异常只写日志后继续，绝不让托盘闪退
        Write-TrayLog "⚠ 轮询异常（已忽略，继续轮询）：$_"
    }
}

# ===================== 主流程 =====================
try {
    # 路径规范化 + 日志目录就绪
    $script:StatusPath = Resolve-FullPath $script:StatusPath
    $script:CmdPath = Resolve-FullPath $script:CmdPath
    $script:IconPath = Resolve-FullPath $script:IconPath
    $script:LogPath = Resolve-FullPath $script:LogPath
    $logDir = Split-Path -Parent $script:LogPath
    if ($logDir -and -not (Test-Path -LiteralPath $logDir)) {
        New-Item -ItemType Directory -Path $logDir -Force | Out-Null
    }

    Write-TrayLog '==== 句听托盘启动 ===='
    Write-TrayLog "参数：StatusPath=$script:StatusPath | CmdPath=$script:CmdPath | IconPath=$script:IconPath | LogPath=$script:LogPath"
    Write-TrayLog "PowerShell 版本：$($PSVersionTable.PSVersion)"

    Add-Type -AssemblyName System.Windows.Forms
    Add-Type -AssemblyName System.Drawing

    # 1) 启动即显示托盘图标，初始提示「句听 · 启动中…」
    $script:notifyIcon = New-Object System.Windows.Forms.NotifyIcon
    $script:notifyIcon.Icon = Load-TrayIcon $script:IconPath
    Set-Tooltip '句听 · 启动中…'
    $script:notifyIcon.Visible = $true
    Write-TrayLog '托盘图标已显示（初始提示：句听 · 启动中…）'

    # 左键单击 = 打开学习端；点击气泡同样打开学习端
    $script:notifyIcon.Add_Click({
        param($sender, $e)
        try {
            if ($e.Button -eq [System.Windows.Forms.MouseButtons]::Left) {
                Write-TrayLog '图标左键单击'
                Open-Url $script:WebUrl
            }
        } catch {
            Write-TrayLog "⚠ 图标单击事件异常：$_"
        }
    })
    $script:notifyIcon.Add_BalloonTipClicked({
        try {
            Open-Url $script:WebUrl
        } catch {
            Write-TrayLog "⚠ 气泡点击事件异常：$_"
        }
    })

    # 2) 右键菜单（赋值后右键才出菜单）
    Build-ContextMenu
    $script:notifyIcon.ContextMenuStrip = $script:contextMenu
    Write-TrayLog '右键菜单已就绪'

    # 3) 500ms 轮询计时器 + 消息循环
    $script:timer = New-Object System.Windows.Forms.Timer
    $script:timer.Interval = 500
    $script:timer.Add_Tick({ On-PollTick })
    $script:timer.Start()
    Write-TrayLog '轮询已启动（每 500 毫秒）'

    Write-TrayLog '进入消息循环，等待托盘交互与状态变化'
    [System.Windows.Forms.Application]::Run()
    Write-TrayLog '消息循环已退出，脚本结束'
    exit 0
} catch {
    # 兜底中的兜底：主体任何异常都要记录原因并清理图标，绝不无声闪退
    Write-TrayLog "⚠ 托盘主流程异常：$_"
    Write-TrayLog "⚠ 调用栈：$($_.ScriptStackTrace)"
    Cleanup-TrayIcon
    exit 1
}
