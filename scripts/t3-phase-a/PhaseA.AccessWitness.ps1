Set-StrictMode -Version Latest
if (-not ('EtherPhaseAAccessWitness' -as [type])) {
  Add-Type -TypeDefinition @"
using System;
using System.IO;
using System.Security.Principal;
using System.Runtime.InteropServices;
using System.Threading;
public static class EtherPhaseAAccessWitness {
  [DllImport("advapi32.dll", SetLastError=true)] static extern bool ImpersonateLoggedOnUser(IntPtr token);
  [DllImport("advapi32.dll", SetLastError=true)] static extern bool RevertToSelf();
  [DllImport("advapi32.dll", SetLastError=true)] static extern bool OpenThreadToken(IntPtr thread, uint access, bool openAsSelf, out IntPtr token);
  [DllImport("kernel32.dll")] static extern IntPtr GetCurrentThread();
  [DllImport("kernel32.dll", SetLastError=true)] static extern bool CloseHandle(IntPtr handle);
  [DllImport("kernel32.dll", CharSet=CharSet.Unicode, SetLastError=true)] static extern IntPtr CreateFileW(string path,uint access,uint share,IntPtr security,uint disposition,uint flags,IntPtr template);
  public sealed class Result { public bool impersonated,attempted,allowed,reverted,handlesClosed; public string sid,operation; public int error; }
  public static Result Probe(IntPtr token,string expectedSid,string operation,string target,string root) {
    if (token==IntPtr.Zero || String.IsNullOrWhiteSpace(expectedSid) || String.IsNullOrWhiteSpace(root) || String.IsNullOrWhiteSpace(target)) throw new ArgumentException();
    string basePath=Path.GetFullPath(root).TrimEnd(Path.DirectorySeparatorChar);
    string full=Path.GetFullPath(target);
    if (!Path.IsPathRooted(basePath) || basePath.StartsWith(@"\\",StringComparison.Ordinal) || !Path.GetFileName(basePath).StartsWith("ether-phase-a-store-",StringComparison.Ordinal)) throw new ArgumentException();
    string protectedFile=Path.Combine(basePath,"protected","original.bin");
    string deniedFile=Path.Combine(basePath,"protected","rejected.bin");
    string controlFile=Path.Combine(basePath,"control","original.bin");
    string authorizedProbe=Path.Combine(basePath,"protected","witness-authorized.bin");
    string permissiveProbe=Path.Combine(basePath,"control","witness-permissive.bin");
    bool allowedPath=(operation=="Read" && (String.Equals(full,protectedFile,StringComparison.OrdinalIgnoreCase) || String.Equals(full,controlFile,StringComparison.OrdinalIgnoreCase))) || (operation=="Overwrite" && (String.Equals(full,protectedFile,StringComparison.OrdinalIgnoreCase) || String.Equals(full,controlFile,StringComparison.OrdinalIgnoreCase))) || (operation=="Create" && (String.Equals(full,deniedFile,StringComparison.OrdinalIgnoreCase) || String.Equals(full,authorizedProbe,StringComparison.OrdinalIgnoreCase) || String.Equals(full,permissiveProbe,StringComparison.OrdinalIgnoreCase)));
    if (!allowedPath) throw new ArgumentException();
    Result result=new Result { operation=operation, sid="", error=-1, handlesClosed=true };
    Thread worker=new Thread(delegate() {
      IntPtr threadToken=IntPtr.Zero, file=IntPtr.Zero; bool active=false;
      try {
        IntPtr prior;
        if (OpenThreadToken(GetCurrentThread(),0x0008,true,out prior)) { if (!CloseHandle(prior)) result.handlesClosed=false; return; }
        if (Marshal.GetLastWin32Error()!=1008) return;
        if (!ImpersonateLoggedOnUser(token)) { result.error=Marshal.GetLastWin32Error(); return; }
        active=true; result.impersonated=true;
        if (!OpenThreadToken(GetCurrentThread(),0x0008,true,out threadToken)) { result.error=Marshal.GetLastWin32Error(); return; }
        using (WindowsIdentity identity=new WindowsIdentity(threadToken)) { result.sid=identity.User.Value; }
        if (!String.Equals(result.sid,expectedSid,StringComparison.Ordinal)) return;
        uint access=operation=="Read" ? 0x80000000u : 0x40000000u;
        uint disposition=operation=="Create" ? 1u : 3u;
        result.attempted=true;
        file=CreateFileW(full,access,7u,IntPtr.Zero,disposition,0x00200080u,IntPtr.Zero);
        if (file==new IntPtr(-1)) { result.error=Marshal.GetLastWin32Error(); file=IntPtr.Zero; }
        else { result.allowed=true; result.error=0; }
      } catch { result.error=-1; }
      finally {
        if (file!=IntPtr.Zero && !CloseHandle(file)) result.handlesClosed=false;
        if (threadToken!=IntPtr.Zero && !CloseHandle(threadToken)) result.handlesClosed=false;
        if (active) {
          if (RevertToSelf()) {
            IntPtr remaining;
            if (OpenThreadToken(GetCurrentThread(),0x0008,true,out remaining)) { if (!CloseHandle(remaining)) result.handlesClosed=false; }
            else if (Marshal.GetLastWin32Error()==1008) result.reverted=true;
          }
        }
      }
    });
    worker.IsBackground=true; worker.Start(); worker.Join();
    return result;
  }
}
"@
}
