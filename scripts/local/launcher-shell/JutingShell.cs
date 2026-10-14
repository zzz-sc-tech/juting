// 句听启动器壳（JutingShell）
// ---------------------------------------------------------------------------
// 取代旧的 87 MB Node SEA 单文件：发布包只保留一份便携 Node（temp\runtime\node\node.exe），
// 本壳（约 15 KB，csc 编译）负责：
//   1. 定位安装根目录（exe 所在目录优先；开发态 exe 位于 temp\launcher-build 时，
//      向上最多 3 层寻找同时含运行时与启动器脚本的祖先目录，保证构建产物就地可自检）；
//   2. 把工作目录切到安装根；
//   3. 用便携 Node 运行 scripts\local\launcher-app.cjs，并把壳收到的全部命令行参数原样转发；
//   4. 泵送子进程 stdout/stderr（字节级原样转发：重定向捕获、文件重定向都可用）；
//   5. 等待子进程结束并透传退出码（壳的生命周期与启动器一致）。
//
// 找不到 Node / 启动器脚本时不静默：stderr 可写（被重定向）→ 写 stderr；有控制台 →
// 写控制台；否则弹 MessageBox 提示重装。任何情况都以非零码退出。
//
// 构建（scripts/local/build-launcher.mjs 调用）：
//   csc /nologo /target:winexe /optimize+ /platform:anycpu /out:句听.exe JutingShell.cs
// ---------------------------------------------------------------------------
using System;
using System.Diagnostics;
using System.IO;
using System.Runtime.InteropServices;
using System.Text;
using System.Threading;
using Microsoft.Win32.SafeHandles;

internal static class JutingShell
{
    private const int StdOutputHandle = -11;
    private const int StdErrorHandle = -12;
    private const uint FileTypeDisk = 0x0001;
    private const uint FileTypePipe = 0x0003;
    private const uint MbOk = 0x00000000;
    private const uint MbIconError = 0x00000010;
    private const uint MbSetForeground = 0x00010000;
    private const uint MbTopmost = 0x00040000;

    private static readonly IntPtr InvalidHandleValue = new IntPtr(-1);

    [DllImport("kernel32.dll", SetLastError = true)]
    private static extern IntPtr GetStdHandle(int nStdHandle);

    [DllImport("kernel32.dll", SetLastError = true)]
    private static extern uint GetFileType(IntPtr hFile);

    [DllImport("kernel32.dll")]
    private static extern IntPtr GetConsoleWindow();

    [DllImport("user32.dll", EntryPoint = "MessageBoxW", CharSet = CharSet.Unicode)]
    private static extern int MessageBoxW(IntPtr hWnd, string lpText, string lpCaption, uint uType);

    private static int Main(string[] args)
    {
        try
        {
            return Run(args);
        }
        catch (Exception ex)
        {
            ReportFatal("句听启动失败：" + ex.Message);
            return 1;
        }
    }

    private static int Run(string[] args)
    {
        string exeDir;
        try
        {
            exeDir = AppDomain.CurrentDomain.BaseDirectory;
            if (string.IsNullOrEmpty(exeDir))
            {
                exeDir = Path.GetDirectoryName(System.Reflection.Assembly.GetExecutingAssembly().Location);
            }
        }
        catch
        {
            exeDir = null;
        }
        if (string.IsNullOrEmpty(exeDir)) exeDir = Directory.GetCurrentDirectory();
        exeDir = NormalizeDir(exeDir);

        string installRoot = ResolveInstallRoot(exeDir);
        try { Directory.SetCurrentDirectory(installRoot); }
        catch { /* 极端环境：忽略，子进程仍显式指定 WorkingDirectory */ }

        string nodePath = Path.Combine(installRoot, "temp", "runtime", "node", "node.exe");
        string appPath = Path.Combine(installRoot, "scripts", "local", "launcher-app.cjs");

        if (!File.Exists(nodePath))
        {
            ReportFatal(
                "安装不完整：未找到运行环境 node.exe" + Environment.NewLine + Environment.NewLine +
                "缺少：" + nodePath + Environment.NewLine + Environment.NewLine +
                "请把压缩包内全部文件（包括 temp 目录）解压到同一文件夹后再运行。");
            return 1;
        }
        if (!File.Exists(appPath))
        {
            ReportFatal(
                "安装不完整：未找到启动器脚本 launcher-app.cjs" + Environment.NewLine + Environment.NewLine +
                "缺少：" + appPath + Environment.NewLine + Environment.NewLine +
                "请把压缩包内全部文件解压到同一文件夹后再运行。");
            return 1;
        }

        ProcessStartInfo startInfo = new ProcessStartInfo();
        startInfo.FileName = nodePath;
        startInfo.Arguments = QuoteArg(appPath) + JoinArgs(args);
        startInfo.UseShellExecute = false;
        startInfo.CreateNoWindow = true;
        startInfo.WorkingDirectory = installRoot;
        startInfo.RedirectStandardOutput = true;
        startInfo.RedirectStandardError = true;

        Process child;
        try
        {
            child = Process.Start(startInfo);
        }
        catch (Exception ex)
        {
            ReportFatal("启动失败：" + ex.Message + Environment.NewLine + Environment.NewLine + "node：" + nodePath);
            return 1;
        }
        if (child == null)
        {
            ReportFatal("启动失败：无法创建 node 进程" + Environment.NewLine + Environment.NewLine + "node：" + nodePath);
            return 1;
        }

        IntPtr outHandle = GetStdHandle(StdOutputHandle);
        IntPtr errHandle = GetStdHandle(StdErrorHandle);
        Stream childOut = child.StandardOutput.BaseStream;
        Stream childErr = child.StandardError.BaseStream;
        Thread outPump = new Thread(delegate() { Pump(childOut, outHandle); });
        Thread errPump = new Thread(delegate() { Pump(childErr, errHandle); });
        outPump.IsBackground = true;
        errPump.IsBackground = true;
        outPump.Start();
        errPump.Start();

        child.WaitForExit();
        outPump.Join(5000);
        errPump.Join(5000);
        int exitCode = child.ExitCode;
        try { child.Dispose(); } catch { /* 忽略 */ }
        return exitCode;
    }

    // 安装根解析：exe 所在目录优先（正常发布形态：exe 位于包根）。
    // 开发/构建态 exe 位于 temp\launcher-build\，该目录不是完整安装；向上最多 3 层，
    // 取第一个同时含 temp\runtime\node\node.exe 与 scripts\local\launcher-app.cjs 的目录。
    // 找不到时回退 exe 所在目录，由上面的缺失检查给出明确报错。
    private static string ResolveInstallRoot(string exeDir)
    {
        string[] candidates = new string[4];
        string cursor = exeDir;
        int count = 0;
        while (cursor != null && count < candidates.Length)
        {
            candidates[count] = cursor;
            count += 1;
            cursor = ParentOrNull(cursor);
        }
        for (int i = 0; i < count; i++)
        {
            string dir = candidates[i];
            if (File.Exists(Path.Combine(dir, "temp", "runtime", "node", "node.exe")) &&
                File.Exists(Path.Combine(dir, "scripts", "local", "launcher-app.cjs")))
            {
                return dir;
            }
        }
        return exeDir;
    }

    private static string ParentOrNull(string dir)
    {
        if (string.IsNullOrEmpty(dir)) return null;
        try
        {
            string trimmed = dir.TrimEnd(Path.DirectorySeparatorChar, Path.AltDirectorySeparatorChar);
            string parent = Path.GetDirectoryName(trimmed);
            if (string.IsNullOrEmpty(parent)) return null;
            if (string.Equals(parent, trimmed, StringComparison.OrdinalIgnoreCase)) return null;
            return parent;
        }
        catch
        {
            return null;
        }
    }

    private static string NormalizeDir(string dir)
    {
        if (string.IsNullOrEmpty(dir)) return dir;
        string trimmed = dir.TrimEnd(Path.DirectorySeparatorChar, Path.AltDirectorySeparatorChar);
        if (trimmed.Length == 0) return dir;
        if (trimmed.Length == 2 && trimmed[1] == ':') return trimmed + Path.DirectorySeparatorChar;
        return trimmed;
    }

    // 字节级泵送：读子进程管道 → 写本进程的标准句柄。
    // 目标句柄不可写（双击场景无重定向）时只排空，防止子进程被管道缓冲堵死。
    private static void Pump(Stream source, IntPtr targetHandle)
    {
        FileStream target = null;
        if (IsValidHandle(targetHandle))
        {
            try { target = new FileStream(new SafeFileHandle(targetHandle, false), FileAccess.Write); }
            catch { target = null; }
        }
        byte[] buffer = new byte[16384];
        try
        {
            int read;
            while ((read = source.Read(buffer, 0, buffer.Length)) > 0)
            {
                if (target != null)
                {
                    try
                    {
                        target.Write(buffer, 0, read);
                        target.Flush();
                    }
                    catch
                    {
                        target = null; // 写端断开：继续排空，避免子进程卡死
                    }
                }
            }
        }
        catch { /* 子进程退出/管道断开 */ }
        finally
        {
            if (target != null)
            {
                try { target.Flush(); } catch { /* 忽略 */ }
                try { target.Dispose(); } catch { /* 忽略 */ }
            }
        }
    }

    // 错误上报：重定向场景写 stderr（原始 UTF-8 字节，便于自动化断言，且不弹窗阻塞）；
    // 有控制台写控制台；两者都没有（用户双击）才弹 MessageBox。
    private static void ReportFatal(string message)
    {
        IntPtr errHandle = GetStdHandle(StdErrorHandle);
        if (IsRedirected(errHandle))
        {
            WriteRawUtf8(errHandle, message + Environment.NewLine);
            return;
        }
        if (GetConsoleWindow() != IntPtr.Zero)
        {
            try
            {
                Console.Error.WriteLine(message);
                return;
            }
            catch { /* 落到 MessageBox */ }
        }
        try
        {
            MessageBoxW(IntPtr.Zero, message, "安装不完整", MbOk | MbIconError | MbSetForeground | MbTopmost);
        }
        catch { /* 无桌面会话：仅退出非零 */ }
    }

    private static void WriteRawUtf8(IntPtr handle, string text)
    {
        try
        {
            byte[] bytes = Encoding.UTF8.GetBytes(text);
            using (FileStream stream = new FileStream(new SafeFileHandle(handle, false), FileAccess.Write))
            {
                stream.Write(bytes, 0, bytes.Length);
                stream.Flush();
            }
        }
        catch { /* 忽略 */ }
    }

    private static bool IsValidHandle(IntPtr handle)
    {
        return handle != IntPtr.Zero && handle != InvalidHandleValue;
    }

    private static bool IsRedirected(IntPtr handle)
    {
        if (!IsValidHandle(handle)) return false;
        uint type = GetFileType(handle);
        return type == FileTypePipe || type == FileTypeDisk;
    }

    private static string JoinArgs(string[] args)
    {
        if (args == null || args.Length == 0) return string.Empty;
        StringBuilder sb = new StringBuilder();
        for (int i = 0; i < args.Length; i++)
        {
            sb.Append(' ');
            sb.Append(QuoteArg(args[i]));
        }
        return sb.ToString();
    }

    // Windows 命令行参数引用（MSVCRT / CommandLineToArgvW 规则），确保参数原样到达 node。
    private static string QuoteArg(string arg)
    {
        if (string.IsNullOrEmpty(arg)) return "\"\"";
        bool needsQuote = false;
        for (int i = 0; i < arg.Length; i++)
        {
            char c = arg[i];
            if (c == ' ' || c == '\t' || c == '"')
            {
                needsQuote = true;
                break;
            }
        }
        if (!needsQuote) return arg;
        StringBuilder sb = new StringBuilder();
        sb.Append('"');
        int backslashes = 0;
        for (int i = 0; i < arg.Length; i++)
        {
            char c = arg[i];
            if (c == '\\')
            {
                backslashes += 1;
                continue;
            }
            if (c == '"')
            {
                sb.Append('\\', backslashes * 2 + 1);
                sb.Append('"');
                backslashes = 0;
                continue;
            }
            if (backslashes > 0)
            {
                sb.Append('\\', backslashes);
                backslashes = 0;
            }
            sb.Append(c);
        }
        if (backslashes > 0) sb.Append('\\', backslashes * 2);
        sb.Append('"');
        return sb.ToString();
    }
}
