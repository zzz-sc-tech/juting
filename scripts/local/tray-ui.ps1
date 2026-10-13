<#
.SYNOPSIS
    句听 JuTing 本地版托盘 UI（PowerShell 5.1 + NotifyIcon 实现）
.DESCRIPTION
    本脚本只负责「托盘图标 + 右键菜单 + 气泡提示」，不启动也不停止任何服务。
    它与 Node 单文件启动器之间仅通过两个 JSON 文件协作，不握手、不起服务、不读 stdin：

    1) 状态文件（托盘只读，Node 只写）：
       temp/runtime/launcher-status.json
       字段：state(starting/running/stopping/stopped/error)、tooltip、message、
             error、balloon({id,title,text})、pid、exePath、autostart、ports、
             version、update({available,version,current,assetName,sizeMb,releaseUrl,
             phase(checking/available/downloading/extracting/applying/error/uptodate),
             progress,message,error})
       注：version/update 为后加字段，老状态文件可能缺失，读取一律容错。
       读取失败 / JSON 解析失败一律当「没有状态」，静默重试，绝不弹错、绝不退出。
       balloon 按 id 去重，同一个 id 只弹一次。

    2) 命令文件（托盘只写，Node 只读并消费）：
       temp/runtime/launcher-cmd.json
       形如 {"action":"stop|focus","ts":"..."}；开机自启为
       {"action":"autostart","value":true|false}；重启为 {"action":"restart"}；
       检查更新为 {"action":"check-update"}；一键更新为 {"action":"update"}。
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
$script:menuCheckUpdate = $null # 「检查更新」菜单项（始终可见）
$script:menuUpdate = $null      # 「更新到 vX」菜单项（仅 status.update.available 为真时可见）
$script:menuAbout = $null       # 「关于 句听 vX」菜单项

$script:checkUpdatePending = $false  # 用户点了「检查更新」，等待 update.phase 变为结束值后恢复
$script:updatePending = $false       # 用户点了「更新到 vX」，等待进入下载态前维持「正在更新…」

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

# ===================== 菜单主题（纸墨书房） =====================
# 与 web 端设计令牌对齐：暖纸 #f7f5f1 / 墨 #1d1b16 / 松绿 #24584a / 发丝分隔线。
# 任一步失败只写日志并退回系统默认样式，绝不影响托盘存活。

$script:TrayThemeCSharp = @'
using System.Drawing;
using System.Windows.Forms;

namespace JuTing.Tray
{
    // 只覆盖菜单相关颜色，其余交给 ProfessionalColorTable 基类
    public class MenuColors : ProfessionalColorTable
    {
        private static readonly Color Paper     = Color.FromArgb(0xF7, 0xF5, 0xF1);
        private static readonly Color Ink       = Color.FromArgb(0x1D, 0x1B, 0x16);
        private static readonly Color Green     = Color.FromArgb(0x24, 0x58, 0x4A);
        private static readonly Color GreenSoft = Color.FromArgb(0xE7, 0xEF, 0xE9);
        private static readonly Color Hairline  = Color.FromArgb(0xDE, 0xD7, 0xC8);
        private static readonly Color Border    = Color.FromArgb(0xCF, 0xC8, 0xBA);

        public override Color ToolStripDropDownBackground   { get { return Paper; } }
        public override Color ImageMarginGradientBegin      { get { return Paper; } }
        public override Color ImageMarginGradientMiddle     { get { return Paper; } }
        public override Color ImageMarginGradientEnd        { get { return Paper; } }
        public override Color MenuStripGradientBegin        { get { return Paper; } }
        public override Color MenuStripGradientEnd          { get { return Paper; } }
        public override Color ToolStripBorder               { get { return Border; } }
        public override Color MenuBorder                    { get { return Border; } }
        public override Color MenuItemBorder                { get { return Green; } }
        public override Color MenuItemSelected              { get { return GreenSoft; } }
        public override Color MenuItemSelectedGradientBegin { get { return GreenSoft; } }
        public override Color MenuItemSelectedGradientEnd   { get { return GreenSoft; } }
        public override Color SeparatorDark                 { get { return Hairline; } }
        public override Color SeparatorLight                { get { return Paper; } }
    }
}
'@

function Set-TrayMenuTheme {
    param($Menu)
    try {
        if (-not ('JuTing.Tray.MenuColors' -as [type])) {
            # 必须显式引用：本函数可能在主流程 Add-Type -AssemblyName 之前被调用，
            # 不带引用时 CodeDom 编译报「缺少程序集引用」（实测）。
            Add-Type -TypeDefinition $script:TrayThemeCSharp `
                -ReferencedAssemblies 'System.Windows.Forms.dll', 'System.Drawing.dll'
        }
        $renderer = New-Object System.Windows.Forms.ToolStripProfessionalRenderer(([JuTing.Tray.MenuColors]::new()))
        $renderer.RoundedEdges = $true
        $Menu.Renderer = $renderer
        $Menu.ShowImageMargin = $false    # 去掉左侧图片留白带（本菜单无图标）
        $Menu.ShowCheckMargin = $true     # 保留勾选位（「开机自动启动」需要）
        foreach ($name in @('Microsoft YaHei UI', 'Microsoft YaHei')) {
            try { $Menu.Font = New-Object System.Drawing.Font($name, 9.0); break } catch { }
        }
        Write-TrayLog '菜单主题：纸墨书房（自定义渲染已应用）'
    } catch {
        Write-TrayLog "⚠ 菜单主题应用失败，退回系统默认样式：$_"
    }
}

# ===================== 菜单与轮询逻辑 =====================

function New-TrayMenuItem {
    param(
        [Parameter(Mandatory = $true)][string]$Text,
        [scriptblock]$OnClick
    )
    $item = New-Object System.Windows.Forms.ToolStripMenuItem
    $item.Text = $Text
    try {
        # 纸墨书房：墨色文字 + 适度内边距（失败静默退回默认）
        $item.ForeColor = [System.Drawing.Color]::FromArgb(0x1D, 0x1B, 0x16)
        $item.Padding = New-Object System.Windows.Forms.Padding(14, 5, 14, 5)
    } catch { }
    if ($OnClick) { $item.Add_Click($OnClick) }
    return $item
}

# 构建右键菜单；菜单项点击事件内部一律 try/catch，写命令文件失败不影响托盘
function Build-ContextMenu {
    $menu = New-Object System.Windows.Forms.ContextMenuStrip
    Set-TrayMenuTheme $menu

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

    $mSep3 = New-Object System.Windows.Forms.ToolStripSeparator

    # 检查更新：始终可见可点；点击下发 check-update，自身先置「正在检查更新…」禁用，待 phase 变为结束值再恢复
    $mCheckUpdate = New-TrayMenuItem '检查更新' {
        try {
            Send-LauncherCommand -Action 'check-update'
            $script:checkUpdatePending = $true
            if ($null -ne $script:menuCheckUpdate) {
                $script:menuCheckUpdate.Text = '正在检查更新…'
                $script:menuCheckUpdate.Enabled = $false
            }
            Write-TrayLog '菜单：检查更新（命令已下发）'
        } catch {
            Write-TrayLog "⚠ 菜单：检查更新 异常：$_"
        }
    }
    $script:menuCheckUpdate = $mCheckUpdate

    # 更新到 vX：仅 status.update.available 为真时可见，文字带目标版本号；点击下发 update
    $mUpdate = New-TrayMenuItem '更新' {
        try {
            Send-LauncherCommand -Action 'update'
            $script:updatePending = $true
            if ($null -ne $script:menuUpdate) {
                $script:menuUpdate.Enabled = $false
                $script:menuUpdate.Text = '正在更新…'
            }
            Write-TrayLog '菜单：一键更新（命令已下发）'
        } catch {
            Write-TrayLog "⚠ 菜单：一键更新 异常：$_"
        }
    }
    $mUpdate.Visible = $false
    $script:menuUpdate = $mUpdate

    # 关于：只弹气泡给出发布地址，绝不 Start-Process 打开链接（让用户自行复制）
    $mAbout = New-TrayMenuItem '关于 句听' {
        try {
            $st = Read-LauncherStatus
            $ver = ''
            if ($null -ne $st -and $null -ne $st.version -and [string]$st.version -ne '') { $ver = [string]$st.version }
            $url = 'https://github.com/zzz-sc-tech/juting/releases'
            if ($null -ne $st -and $null -ne $st.update -and $null -ne $st.update.releaseUrl -and [string]$st.update.releaseUrl -ne '') {
                $url = [string]$st.update.releaseUrl
            }
            $title = '句听'
            if ($ver) { $title = "句听 v$ver" }
            Show-Balloon $title $url 'Info'
            Write-TrayLog '菜单：关于（气泡已给出发布地址）'
        } catch {
            Write-TrayLog "⚠ 菜单：关于 异常：$_"
        }
    }
    $script:menuAbout = $mAbout

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
    $null = $menu.Items.Add($mSep3)
    $null = $menu.Items.Add($mCheckUpdate)
    $null = $menu.Items.Add($mUpdate)
    $null = $menu.Items.Add($mAbout)
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

        # ---- 更新相关菜单项（update 字段可能不存在，一律容错）----
        $upd = $null
        if ($null -ne $Status -and $null -ne $Status.update) { $upd = $Status.update }
        $phase = ''
        if ($null -ne $upd -and $null -ne $upd.phase) { $phase = [string]$upd.phase }
        # 更新进行中：下载/解压/安装三态，此时 1、2 两项都禁用
        $busy = ($phase -eq 'downloading' -or $phase -eq 'extracting' -or $phase -eq 'applying')
        $avail = ($null -ne $upd -and $null -ne $upd.available -and [System.Convert]::ToBoolean($upd.available))
        $uver = ''
        if ($null -ne $upd -and $null -ne $upd.version) { $uver = [string]$upd.version }

        # 「检查更新」：始终可见；检查中禁用并显示「正在检查更新…」，phase 变为结束值（uptodate/available/error）后恢复
        if ($null -ne $script:menuCheckUpdate) {
            if ($script:menuCheckUpdate.Visible -ne $true) { $script:menuCheckUpdate.Visible = $true }
            $checking = $script:checkUpdatePending
            if ($checking -and ($phase -eq 'uptodate' -or $phase -eq 'available' -or $phase -eq 'error')) {
                $script:checkUpdatePending = $false
                $checking = $false
            }
            if ($checking) {
                if ($script:menuCheckUpdate.Text -ne '正在检查更新…') { $script:menuCheckUpdate.Text = '正在检查更新…' }
                $script:menuCheckUpdate.Enabled = $false
            } else {
                if ($script:menuCheckUpdate.Text -ne '检查更新') { $script:menuCheckUpdate.Text = '检查更新' }
                $script:menuCheckUpdate.Enabled = -not $busy
            }
        }

        # 「更新到 vX」：更新进行中强制可见并显示 update.message；否则仅 available=true 时可见
        if ($null -ne $script:menuUpdate) {
            if ($busy) {
                $script:updatePending = $false
                if ($script:menuUpdate.Visible -ne $true) { $script:menuUpdate.Visible = $true }
                $script:menuUpdate.Enabled = $false
                $umsg = ''
                if ($null -ne $upd -and $null -ne $upd.message) { $umsg = [string]$upd.message }
                if (-not $umsg) { $umsg = '正在更新…' }
                if ($script:menuUpdate.Text -ne $umsg) { $script:menuUpdate.Text = $umsg }
            } else {
                $utext = '更新到新版本'
                if ($uver) { $utext = "更新到 v$uver" }
                $uvisible = [bool]$avail
                $uenabled = $true
                # 已点击更新但尚未进入下载态：维持「正在更新…」禁用，避免被下次轮询重置
                if ($script:updatePending) {
                    $utext = '正在更新…'
                    $uvisible = $true
                    $uenabled = $false
                }
                if ($script:menuUpdate.Visible -ne $uvisible) { $script:menuUpdate.Visible = $uvisible }
                if ($script:menuUpdate.Text -ne $utext) { $script:menuUpdate.Text = $utext }
                $script:menuUpdate.Enabled = $uenabled
            }
        }

        # 「关于 句听 vX」：始终可见可点，文字跟随 status.version
        if ($null -ne $script:menuAbout) {
            if ($script:menuAbout.Visible -ne $true) { $script:menuAbout.Visible = $true }
            $script:menuAbout.Enabled = $true
            $ver = ''
            if ($null -ne $Status -and $null -ne $Status.version -and [string]$Status.version -ne '') { $ver = [string]$Status.version }
            $atext = '关于 句听'
            if ($ver) { $atext = "关于 句听 v$ver" }
            if ($script:menuAbout.Text -ne $atext) { $script:menuAbout.Text = $atext }
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

        # 更新阶段（update 字段可能不存在）：downloading/extracting/applying 视为更新进行中
        $updPhase = ''
        if ($null -ne $status.update -and $null -ne $status.update.phase) { $updPhase = [string]$status.update.phase }
        $updateBusy = ($updPhase -eq 'downloading' -or $updPhase -eq 'extracting' -or $updPhase -eq 'applying')

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
        # 更新进行中的 stopped 是「更新器接管」而非用户停止，跳过启动器的「已停止」气泡避免误导
        if ($null -ne $status.balloon -and -not ($state -eq 'stopped' -and $updateBusy)) {
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
            if ($updateBusy) {
                # 更新器即将覆盖安装并自动重启句听，最后一次气泡改为更新相关，跳过「已停止」
                Show-Balloon '句听' '更新中，句听会自动重启' 'Info'
                Exit-Tray "检测到 state=stopped（更新中：$updPhase），托盘退出，更新器将自动重启句听"
            } else {
                Exit-Tray '检测到 state=stopped，托盘退出'
            }
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
