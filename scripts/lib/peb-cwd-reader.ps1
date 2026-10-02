# PEB 读取器：取任意进程的当前工作目录（CWD）。
#
# 只在 PowerShell 7+ 下可用：
# Windows PowerShell 5.1 解析 Add-Type 的多行 here-string 会被语言模式拦下，
# 所以调用方（who-locks-dir.ps1）必须用 try/catch 点源加载，失败就退化为命令行线索。
#
# 为什么需要它：Windows 上"目录既删不掉也改不了名"最常见的原因，是某个进程把该目录
# 当作当前工作目录（CWD）。而 CWD 和进程 exe 的位置毫无关系 —— 例如绿色版 Sublime 的
# plugin_host-3.3.exe 位于 D:\SublimeText，却停在项目的 release 目录上。

if ('PebReader' -as [type]) { return }

Add-Type -TypeDefinition @'
using System;
using System.Runtime.InteropServices;
using System.Text;

public static class PebReader
{
    [StructLayout(LayoutKind.Sequential)]
    private struct PROCESS_BASIC_INFORMATION
    {
        public IntPtr Reserved1;
        public IntPtr PebBaseAddress;
        public IntPtr Reserved2_0;
        public IntPtr Reserved2_1;
        public IntPtr UniqueProcessId;
        public IntPtr Reserved3;
    }

    [DllImport("ntdll.dll")]
    private static extern int NtQueryInformationProcess(IntPtr handle, int infoClass,
        ref PROCESS_BASIC_INFORMATION info, int length, out int returnLength);

    [DllImport("kernel32.dll", SetLastError = true)]
    private static extern IntPtr OpenProcess(int access, bool inherit, int pid);

    [DllImport("kernel32.dll", SetLastError = true)]
    private static extern bool ReadProcessMemory(IntPtr handle, IntPtr address,
        byte[] buffer, int size, out IntPtr read);

    [DllImport("kernel32.dll", SetLastError = true)]
    private static extern bool CloseHandle(IntPtr handle);

    public static string GetWorkingDirectory(int pid)
    {
        const int PROCESS_QUERY_INFORMATION = 0x0400;
        const int PROCESS_VM_READ = 0x0010;
        IntPtr handle = OpenProcess(PROCESS_QUERY_INFORMATION | PROCESS_VM_READ, false, pid);
        if (handle == IntPtr.Zero) return null;
        try
        {
            var basic = new PROCESS_BASIC_INFORMATION();
            int returned;
            if (NtQueryInformationProcess(handle, 0, ref basic, Marshal.SizeOf(basic), out returned) != 0)
                return null;

            // PEB->ProcessParameters：x64 偏移 0x20，x86 偏移 0x10
            int paramsOffset = IntPtr.Size == 8 ? 0x20 : 0x10;
            byte[] pointerBuffer = new byte[IntPtr.Size];
            IntPtr read;
            if (!ReadProcessMemory(handle, IntPtr.Add(basic.PebBaseAddress, paramsOffset),
                pointerBuffer, IntPtr.Size, out read)) return null;
            IntPtr processParameters = (IntPtr)(IntPtr.Size == 8
                ? BitConverter.ToInt64(pointerBuffer, 0)
                : BitConverter.ToInt32(pointerBuffer, 0));

            // RTL_USER_PROCESS_PARAMETERS->CurrentDirectory.DosPath：x64 0x38，x86 0x24
            int cwdOffset = IntPtr.Size == 8 ? 0x38 : 0x24;
            byte[] usBuffer = new byte[IntPtr.Size == 8 ? 16 : 8];
            if (!ReadProcessMemory(handle, IntPtr.Add(processParameters, cwdOffset),
                usBuffer, usBuffer.Length, out read)) return null;

            ushort length = BitConverter.ToUInt16(usBuffer, 0);
            IntPtr stringBuffer = (IntPtr)(IntPtr.Size == 8
                ? BitConverter.ToInt64(usBuffer, 8)
                : BitConverter.ToInt32(usBuffer, 4));
            if (length == 0 || stringBuffer == IntPtr.Zero) return null;

            byte[] text = new byte[length];
            if (!ReadProcessMemory(handle, stringBuffer, text, length, out read)) return null;
            return Encoding.Unicode.GetString(text);
        }
        catch { return null; }
        finally { CloseHandle(handle); }
    }
}
'@ -ErrorAction Stop
