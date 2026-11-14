if (-not ("EtherPhaseANative" -as [type])) {
  Add-Type -TypeDefinition @"
using System;
using System.ComponentModel;
using System.Diagnostics;
using System.Runtime.InteropServices;
using System.Security.Principal;
public static class EtherPhaseANative {
    [DllImport("advapi32.dll", SetLastError=true)]
    private static extern bool OpenProcessToken(IntPtr h, uint access, out IntPtr token);
    [DllImport("advapi32.dll", SetLastError=true)]
    private static extern bool GetTokenInformation(IntPtr token, int kind, out int value, int length, out int returned);
    [DllImport("kernel32.dll", SetLastError=true)]
    private static extern bool CloseHandle(IntPtr handle);
    public sealed class TokenRecord {
        public int pid;
        public string sid;
        public bool admin;
        public bool elevated;
        public bool standard;
        public string createdAt;
    }
    public static TokenRecord Inspect(Process process) {
        if (process.HasExited) throw new InvalidOperationException("Process exited");
        IntPtr token;
        if (!OpenProcessToken(process.Handle, 0x0008, out token)) throw new Win32Exception(Marshal.GetLastWin32Error());
        try {
            int elevation, size;
            if (!GetTokenInformation(token, 20, out elevation, sizeof(int), out size)) throw new Win32Exception(Marshal.GetLastWin32Error());
            using (WindowsIdentity identity = new WindowsIdentity(token)) {
                bool admin = false, standard = false;
                foreach (IdentityReference group in identity.Groups) {
                    if (String.Equals(group.Value, "S-1-5-32-544", StringComparison.Ordinal)) admin = true;
                    if (String.Equals(group.Value, "S-1-5-32-545", StringComparison.Ordinal)) standard = true;
                }
                if (process.HasExited) throw new InvalidOperationException("Process exited");
                return new TokenRecord { pid=process.Id, sid=identity.User.Value, admin=admin,
                    elevated=elevation != 0, standard=standard, createdAt=process.StartTime.ToUniversalTime().ToString("o") };
            }
        } finally { CloseHandle(token); }
    }
}
"@
}
function Get-PhaseAProcessToken([Diagnostics.Process]$Process) {
  return [EtherPhaseANative]::Inspect($Process)
}
if (-not ("EtherPhaseAJob" -as [type])) {
  Add-Type -TypeDefinition @"
using System;
using System.ComponentModel;
using System.Runtime.InteropServices;
public static class EtherPhaseAJob {
    [StructLayout(LayoutKind.Sequential)]
    private struct BasicLimit {
        public long PerProcessUserTimeLimit, PerJobUserTimeLimit;
        public uint LimitFlags;
        public UIntPtr MinimumWorkingSetSize, MaximumWorkingSetSize;
        public uint ActiveProcessLimit;
        public UIntPtr Affinity;
        public uint PriorityClass, SchedulingClass;
    }
    [StructLayout(LayoutKind.Sequential)]
    private struct IoCounters {
        public ulong ReadOperationCount, WriteOperationCount, OtherOperationCount;
        public ulong ReadTransferCount, WriteTransferCount, OtherTransferCount;
    }
    [StructLayout(LayoutKind.Sequential)]
    private struct ExtendedLimit {
        public BasicLimit BasicLimitInformation;
        public IoCounters IoInfo;
        public UIntPtr ProcessMemoryLimit, JobMemoryLimit, PeakProcessMemoryUsed, PeakJobMemoryUsed;
    }
    [DllImport("kernel32.dll", CharSet=CharSet.Unicode, SetLastError=true)]
    private static extern IntPtr CreateJobObject(IntPtr attributes, string name);
    [DllImport("kernel32.dll", SetLastError=true)]
    private static extern bool SetInformationJobObject(IntPtr job, int cls, ref ExtendedLimit value, uint length);
    [DllImport("kernel32.dll", SetLastError=true)]
    private static extern bool AssignProcessToJobObject(IntPtr job, IntPtr process);
    [DllImport("kernel32.dll", SetLastError=true)]
    private static extern bool IsProcessInJob(IntPtr process, IntPtr job, out bool result);
    [DllImport("kernel32.dll", SetLastError=true)]
    private static extern bool CloseHandle(IntPtr handle);
    [DllImport("kernel32.dll", SetLastError=true)]
    private static extern bool QueryInformationJobObject(IntPtr job, int cls, out ExtendedLimit value, uint length, out uint returned);
    [DllImport("kernel32.dll", CharSet=CharSet.Unicode, SetLastError=true)]
    private static extern IntPtr GetModuleHandle(string name);
    [DllImport("kernel32.dll", CharSet=CharSet.Ansi, SetLastError=true)]
    private static extern IntPtr GetProcAddress(IntPtr module, string name);
    [UnmanagedFunctionPointer(CallingConvention.Winapi)]
    private delegate int NtQueryObjectDelegate(IntPtr handle, int infoClass, IntPtr info, uint length, out uint returned);
    [DllImport("kernel32.dll", SetLastError=true)]
    private static extern IntPtr OpenProcess(uint access, bool inherit, int pid);
    [DllImport("kernel32.dll")]
    private static extern IntPtr GetCurrentProcess();
    [DllImport("kernel32.dll", SetLastError=true)]
    private static extern bool DuplicateHandle(IntPtr sourceProcess, IntPtr sourceHandle, IntPtr targetProcess, out IntPtr targetHandle, uint access, bool inherit, uint options);
    public static IntPtr DuplicateQueryFromProcess(int pid, long handleValue) {
        if (pid<=0 || handleValue<=0) throw new ArgumentException("Invalid process or job handle");
        IntPtr source=OpenProcess(0x0040,false,pid);
        if (source==IntPtr.Zero) throw new Win32Exception(Marshal.GetLastWin32Error());
        IntPtr copy=IntPtr.Zero;
        try {
            if (!DuplicateHandle(source,new IntPtr(handleValue),GetCurrentProcess(),out copy,0x0004,false,0)) throw new Win32Exception(Marshal.GetLastWin32Error());
            return copy;
        } finally {
            if (!CloseHandle(source)) {
                int error=Marshal.GetLastWin32Error();
                if (copy!=IntPtr.Zero) CloseHandle(copy);
                throw new Win32Exception(error);
            }
        }
    }
    public static uint QueryLimitFlags(IntPtr job) {
        ExtendedLimit value; uint returned;
        if (!QueryInformationJobObject(job,9,out value,(uint)Marshal.SizeOf(typeof(ExtendedLimit)),out returned)) throw new Win32Exception(Marshal.GetLastWin32Error());
        return value.BasicLimitInformation.LimitFlags;
    }
    public static uint QueryHandleCount(IntPtr job) {
        IntPtr module=GetModuleHandle("ntdll.dll");
        if (module==IntPtr.Zero) throw new Win32Exception(Marshal.GetLastWin32Error());
        IntPtr entry=GetProcAddress(module,"NtQueryObject");
        if (entry==IntPtr.Zero) throw new Win32Exception(Marshal.GetLastWin32Error());
        var query=(NtQueryObjectDelegate)Marshal.GetDelegateForFunctionPointer(entry,typeof(NtQueryObjectDelegate));
        IntPtr info=Marshal.AllocHGlobal(56);
        try {
            uint returned; int status=query(job,0,info,56,out returned);
            if (status<0 || returned<16) throw new InvalidOperationException("Job handle count unavailable");
            return unchecked((uint)Marshal.ReadInt32(info,8));
        } finally { Marshal.FreeHGlobal(info); }
    }
    public static IntPtr Create() {
        IntPtr job=CreateJobObject(IntPtr.Zero,null);
        if (job==IntPtr.Zero) throw new Win32Exception(Marshal.GetLastWin32Error());
        ExtendedLimit value=new ExtendedLimit(); value.BasicLimitInformation.LimitFlags=0x2000;
        if (!SetInformationJobObject(job,9,ref value,(uint)Marshal.SizeOf(typeof(ExtendedLimit)))) {
            int error=Marshal.GetLastWin32Error(); CloseHandle(job); throw new Win32Exception(error);
        }
        return job;
    }
    public static bool Contains(IntPtr job, IntPtr process) { bool result; if (!IsProcessInJob(process,job,out result)) throw new Win32Exception(Marshal.GetLastWin32Error()); return result; }
    public static void Assign(IntPtr job, IntPtr process) {
        if (!AssignProcessToJobObject(job,process)) throw new Win32Exception(Marshal.GetLastWin32Error());
    }
    public static void Close(IntPtr job) {
        if (job!=IntPtr.Zero && !CloseHandle(job)) throw new Win32Exception(Marshal.GetLastWin32Error());
    }
}
"@
}
