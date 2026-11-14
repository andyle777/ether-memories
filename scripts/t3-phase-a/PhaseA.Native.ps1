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
                bool admin = false;
                foreach (IdentityReference group in identity.Groups) {
                    if (String.Equals(group.Value, "S-1-5-32-544", StringComparison.Ordinal)) admin = true;
                }
                if (process.HasExited) throw new InvalidOperationException("Process exited");
                return new TokenRecord { pid=process.Id, sid=identity.User.Value, admin=admin,
                    elevated=elevation != 0, createdAt=process.StartTime.ToUniversalTime().ToString("o") };
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
    private static extern bool CloseHandle(IntPtr handle);
    public static IntPtr Create() {
        IntPtr job=CreateJobObject(IntPtr.Zero,null);
        if (job==IntPtr.Zero) throw new Win32Exception(Marshal.GetLastWin32Error());
        ExtendedLimit value=new ExtendedLimit(); value.BasicLimitInformation.LimitFlags=0x2000;
        if (!SetInformationJobObject(job,9,ref value,(uint)Marshal.SizeOf(typeof(ExtendedLimit)))) {
            int error=Marshal.GetLastWin32Error(); CloseHandle(job); throw new Win32Exception(error);
        }
        return job;
    }
    public static void Assign(IntPtr job, IntPtr process) {
        if (!AssignProcessToJobObject(job,process)) throw new Win32Exception(Marshal.GetLastWin32Error());
    }
    public static void Close(IntPtr job) {
        if (job!=IntPtr.Zero && !CloseHandle(job)) throw new Win32Exception(Marshal.GetLastWin32Error());
    }
}
"@
}
