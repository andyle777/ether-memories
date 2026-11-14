# Local same-identity feasibility probe only. Not wired into the manager.
if (-not ('EtherPhaseAAtomic' -as [type])) {
Add-Type -TypeDefinition @'
using System;
using System.Text;
using System.ComponentModel;
using System.Runtime.InteropServices;
public sealed class EtherPhaseAAtomic : IDisposable {
  [StructLayout(LayoutKind.Sequential, CharSet=CharSet.Unicode)]
  struct StartupInfo {
    public int cb; public string reserved, desktop, title;
    public int x,y,xSize,ySize,xCount,yCount,fill,flags;
    public short showWindow, reserved2; public IntPtr reservedPtr, stdIn, stdOut, stdErr;
  }
  [StructLayout(LayoutKind.Sequential)] struct StartupInfoEx { public StartupInfo startup; public IntPtr attributes; }
  [StructLayout(LayoutKind.Sequential)] struct ProcessInfo { public IntPtr process, thread; public int pid, tid; }
  [DllImport("kernel32.dll", SetLastError=true)] static extern IntPtr GetCurrentProcess();
  [DllImport("advapi32.dll", SetLastError=true)] static extern bool OpenProcessToken(IntPtr process, uint access, out IntPtr token);
  [DllImport("kernel32.dll", SetLastError=true)] static extern bool InitializeProcThreadAttributeList(IntPtr list, int count, int flags, ref IntPtr size);
  [DllImport("kernel32.dll", SetLastError=true)] static extern bool UpdateProcThreadAttribute(IntPtr list, uint flags, IntPtr attribute, IntPtr value, IntPtr size, IntPtr previous, IntPtr returned);
  [DllImport("kernel32.dll")] static extern void DeleteProcThreadAttributeList(IntPtr list);
  [DllImport("advapi32.dll", CharSet=CharSet.Unicode, SetLastError=true)]
  static extern bool CreateProcessAsUserW(IntPtr token, string app, StringBuilder command, IntPtr pa, IntPtr ta, bool inherit, uint flags, IntPtr env, string dir, ref StartupInfoEx startup, out ProcessInfo info);
  [DllImport("kernel32.dll", SetLastError=true)] static extern bool IsProcessInJob(IntPtr process, IntPtr job, out bool result);
  [DllImport("kernel32.dll", SetLastError=true)] static extern uint ResumeThread(IntPtr thread);
  [DllImport("kernel32.dll", SetLastError=true)] static extern uint WaitForSingleObject(IntPtr handle, uint milliseconds);
  [DllImport("kernel32.dll", SetLastError=true)] static extern bool GetExitCodeProcess(IntPtr process, out uint code);
  [DllImport("kernel32.dll", SetLastError=true)] static extern bool TerminateProcess(IntPtr process, uint code);
  [DllImport("kernel32.dll", SetLastError=true)] static extern bool CloseHandle(IntPtr handle);
  readonly IntPtr job; IntPtr process, thread;
  public int Pid { get; private set; }
  EtherPhaseAAtomic(IntPtr j, ProcessInfo p) { job=j; process=p.process; thread=p.thread; Pid=p.pid; }
  static void Require(bool success) { if (!success) throw new Win32Exception(Marshal.GetLastWin32Error()); }
  public static EtherPhaseAAtomic CreateCurrentUser(IntPtr job, string app, string command) {
    IntPtr token=IntPtr.Zero;
    try {
      Require(OpenProcessToken(GetCurrentProcess(), 0x000b, out token));
      return CreateWithToken(token,job,app,command);
    } finally { if(token!=IntPtr.Zero) CloseHandle(token); }
  }
  public static EtherPhaseAAtomic CreateWithToken(IntPtr token, IntPtr job, string app, string command) {
    return CreateWithTokenInDirectory(token,job,app,command,System.IO.Path.GetTempPath());
  }
  public static EtherPhaseAAtomic CreateWithTokenInDirectory(IntPtr token, IntPtr job, string app, string command, string tempPath) {
    if (token == IntPtr.Zero || job == IntPtr.Zero || String.IsNullOrEmpty(app) || String.IsNullOrEmpty(command)) throw new ArgumentException();
    if (String.IsNullOrWhiteSpace(tempPath) || tempPath.IndexOf('\0')>=0 || tempPath.IndexOf('=')>=0) throw new ArgumentException();
    IntPtr list=IntPtr.Zero, value=IntPtr.Zero, env=IntPtr.Zero, size=IntPtr.Zero;
    bool initialized=false;
    try {
      InitializeProcThreadAttributeList(IntPtr.Zero, 1, 0, ref size);
      if (size == IntPtr.Zero) throw new Win32Exception(Marshal.GetLastWin32Error());
      list=Marshal.AllocHGlobal(size); Require(InitializeProcThreadAttributeList(list,1,0,ref size)); initialized=true;
      value=Marshal.AllocHGlobal(IntPtr.Size); Marshal.WriteIntPtr(value,job);
      Require(UpdateProcThreadAttribute(list,0,new IntPtr(0x2000d),value,new IntPtr(IntPtr.Size),IntPtr.Zero,IntPtr.Zero));
      StartupInfoEx start=new StartupInfoEx(); start.startup.cb=Marshal.SizeOf(typeof(StartupInfoEx)); start.attributes=list;
      string windows=Environment.GetFolderPath(Environment.SpecialFolder.Windows);
      if (String.IsNullOrEmpty(windows)) throw new InvalidOperationException("Windows directory unavailable");
      string system=System.IO.Path.Combine(windows,"System32");
      string temp=System.IO.Path.GetFullPath(tempPath).TrimEnd('\\');
      string environment="PATH=" + system + "\0SystemRoot=" + windows + "\0TEMP=" + temp + "\0TMP=" + temp + "\0WINDIR=" + windows + "\0\0";
      byte[] envBytes=Encoding.Unicode.GetBytes(environment);
      env=Marshal.AllocHGlobal(envBytes.Length); Marshal.Copy(envBytes,0,env,envBytes.Length);
      ProcessInfo info;
      Require(CreateProcessAsUserW(token,app,new StringBuilder(command),IntPtr.Zero,IntPtr.Zero,false,0x00080404,env,temp,ref start,out info));
      return new EtherPhaseAAtomic(job,info);
    } finally {
      if(initialized) DeleteProcThreadAttributeList(list);
      if(list!=IntPtr.Zero) Marshal.FreeHGlobal(list);
      if(value!=IntPtr.Zero) Marshal.FreeHGlobal(value);
      if(env!=IntPtr.Zero) Marshal.FreeHGlobal(env);
    }
  }
  public bool InJob() { bool yes; Require(IsProcessInJob(process,job,out yes)); return yes; }
  public void Resume() { if (!InJob()) throw new InvalidOperationException("Child is not in job"); if (ResumeThread(thread)==0xffffffff) throw new Win32Exception(Marshal.GetLastWin32Error()); }
  public bool Wait(uint ms) { uint r=WaitForSingleObject(process,ms); if(r==0xffffffff) throw new Win32Exception(Marshal.GetLastWin32Error()); return r==0; }
  public bool Exited() { return Wait(0); }
  public int ExitCode() { uint code; Require(GetExitCodeProcess(process,out code)); if (code==259) throw new InvalidOperationException("Process is still active"); return unchecked((int)code); }
  public void Terminate() { Require(TerminateProcess(process,1)); }
  public void Dispose() {
    int error=0;
    if(thread!=IntPtr.Zero) { if(!CloseHandle(thread)) error=Marshal.GetLastWin32Error(); thread=IntPtr.Zero; }
    if(process!=IntPtr.Zero) { if(!CloseHandle(process) && error==0) error=Marshal.GetLastWin32Error(); process=IntPtr.Zero; }
    if(error!=0) throw new Win32Exception(error);
  }
}
'@
}
