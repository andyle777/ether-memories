param(
  [Parameter(Mandatory = $true)][string]$WorkerScript,
  [Parameter(Mandatory = $true)][string]$ReadyPath
)

$ErrorActionPreference = "Stop"

function Ensure-ParentDirectory([string]$TargetPath) {
  if ([string]::IsNullOrWhiteSpace($TargetPath)) { return }
  $parent = Split-Path -Parent $TargetPath
  if (-not [string]::IsNullOrWhiteSpace($parent) -and -not (Test-Path -LiteralPath $parent)) {
    New-Item -ItemType Directory -Path $parent -Force | Out-Null
  }
}

$native = @'
using System;
using System.Runtime.InteropServices;

public static class Phase2JobNative
{
    [StructLayout(LayoutKind.Sequential)]
    private struct BasicLimitInformation
    {
        public long PerProcessUserTimeLimit;
        public long PerJobUserTimeLimit;
        public uint LimitFlags;
        public UIntPtr MinimumWorkingSetSize;
        public UIntPtr MaximumWorkingSetSize;
        public uint ActiveProcessLimit;
        public UIntPtr Affinity;
        public uint PriorityClass;
        public uint SchedulingClass;
    }

    [StructLayout(LayoutKind.Sequential)]
    private struct IoCounters
    {
        public ulong ReadOperationCount;
        public ulong WriteOperationCount;
        public ulong OtherOperationCount;
        public ulong ReadTransferCount;
        public ulong WriteTransferCount;
        public ulong OtherTransferCount;
    }

    [StructLayout(LayoutKind.Sequential)]
    private struct ExtendedLimitInformation
    {
        public BasicLimitInformation BasicLimitInformation;
        public IoCounters IoInfo;
        public UIntPtr ProcessMemoryLimit;
        public UIntPtr JobMemoryLimit;
        public UIntPtr PeakProcessMemoryUsed;
        public UIntPtr PeakJobMemoryUsed;
    }

    [DllImport("kernel32.dll", CharSet = CharSet.Unicode, SetLastError = true)]
    private static extern IntPtr CreateJobObject(IntPtr securityAttributes, string name);

    [DllImport("kernel32.dll", SetLastError = true)]
    private static extern bool SetInformationJobObject(
        IntPtr job, int informationClass, ref ExtendedLimitInformation information, uint length);

    [DllImport("kernel32.dll", SetLastError = true)]
    private static extern IntPtr OpenProcess(uint desiredAccess, bool inheritHandle, int processId);

    [DllImport("kernel32.dll", SetLastError = true)]
    private static extern bool AssignProcessToJobObject(IntPtr job, IntPtr process);

    [DllImport("kernel32.dll", SetLastError = true)]
    private static extern bool CloseHandle(IntPtr handle);

    public static IntPtr CreateKillOnCloseJob()
    {
        IntPtr job = CreateJobObject(IntPtr.Zero, null);
        if (job == IntPtr.Zero)
            throw new System.ComponentModel.Win32Exception(Marshal.GetLastWin32Error(), "CreateJobObject failed.");

        ExtendedLimitInformation information = new ExtendedLimitInformation();
        information.BasicLimitInformation.LimitFlags = 0x00002000;
        if (!SetInformationJobObject(job, 9, ref information, (uint)Marshal.SizeOf(typeof(ExtendedLimitInformation))))
        {
            int error = Marshal.GetLastWin32Error();
            CloseOwnedHandle(job);
            throw new System.ComponentModel.Win32Exception(error, "SetInformationJobObject failed.");
        }
        return job;
    }

    public static void CloseOwnedHandle(IntPtr handle)
    {
        if (handle == IntPtr.Zero)
            return;
        if (!CloseHandle(handle))
        {
            int error = Marshal.GetLastWin32Error();
            if (error != 0)
                throw new System.ComponentModel.Win32Exception(error, "CloseHandle failed.");
        }
    }

    public static void Assign(IntPtr job, int processId)
    {
        const uint access = 0x0100 | 0x0001 | 0x1000;
        IntPtr process = OpenProcess(access, false, processId);
        if (process == IntPtr.Zero)
            throw new System.ComponentModel.Win32Exception(Marshal.GetLastWin32Error(), "OpenProcess failed.");
        try
        {
            if (!AssignProcessToJobObject(job, process))
                throw new System.ComponentModel.Win32Exception(Marshal.GetLastWin32Error(), "AssignProcessToJobObject failed.");
        }
        finally
        {
            CloseOwnedHandle(process);
        }
    }
}
'@

Add-Type -TypeDefinition $native -ErrorAction Stop
$job = [Phase2JobNative]::CreateKillOnCloseJob()
$worker = Start-Process -FilePath (Join-Path $PSHOME "powershell.exe") `
  -ArgumentList @("-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-File", "`"$WorkerScript`"", "-Mode", "Idle") `
  -PassThru
$assignmentFailure = $null
try {
  try {
    [Phase2JobNative]::Assign($job, -1)
    throw "Negative-control assignment unexpectedly succeeded."
  } catch {
    $assignmentFailure = $_.Exception
  }
  if ($null -eq $assignmentFailure) {
    throw "Negative-control assignment did not produce a preserved failure for invalid pid -1."
  }
  $workerProcessId = $worker.Id
  try {
    [Phase2JobNative]::Assign($job, $workerProcessId)
  } catch {
    if (-not $worker.HasExited) { Stop-Process -Id $worker.Id -Force }
    throw
  }
  Ensure-ParentDirectory $ReadyPath
  [IO.File]::WriteAllText($ReadyPath, "$PID`n$workerProcessId")
  while ($true) {
    Start-Sleep -Seconds 1
  }
} catch {
  if (-not $worker.HasExited) {
    Stop-Process -Id $worker.Id -Force -ErrorAction SilentlyContinue
  }
  throw
} finally {
  if ($null -ne $job) {
    try { [Phase2JobNative]::CloseOwnedHandle($job) } catch { }
  }
  if ($null -ne $worker -and -not $worker.HasExited) {
    Stop-Process -Id $worker.Id -Force -ErrorAction SilentlyContinue
  }
}
