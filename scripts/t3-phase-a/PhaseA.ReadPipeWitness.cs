using System;
using System.IO;
using System.IO.Pipes;
using System.Runtime.InteropServices;
using System.Security.Principal;
using System.Diagnostics;
using System.Threading;
public static class PhaseAReadPipeWitness {
 [DllImport("kernel32.dll",CharSet=CharSet.Unicode,SetLastError=true)] static extern IntPtr CreateFileW(string p,uint access,uint share,IntPtr sa,uint mode,uint flags,IntPtr t);
 [DllImport("kernel32.dll",SetLastError=true)] static extern bool CloseHandle(IntPtr h);
 public static int Main(string[] a) {
  if(a.Length!=5 || (a[0]!="read" && a[0]!="stall") || a[3].Length!=32 || (a[4]!="protectedFile" && a[4]!="controlFile")) return 22;
  if(a[0]=="stall") Thread.Sleep(60000);
  IntPtr f=CreateFileW(a[1],0x80000000,7,IntPtr.Zero,3,0x00200080,IntPtr.Zero);
  bool ok=f!=new IntPtr(-1); int err=ok?0:Marshal.GetLastWin32Error();
  if(ok && !CloseHandle(f)) return 23;
  using(var proc=Process.GetCurrentProcess()) using(var ident=WindowsIdentity.GetCurrent()) using(var pipe=new NamedPipeClientStream(".",a[2],PipeDirection.Out,PipeOptions.None,TokenImpersonationLevel.Identification)) {
   pipe.Connect(3000);
   string record=String.Join("|",new string[]{a[3],proc.Id.ToString(),proc.StartTime.ToUniversalTime().ToString("o"),ident.User.Value,"Read",a[4],ok?"ALLOWED":"ERROR",err.ToString()});
   byte[] bytes=System.Text.Encoding.UTF8.GetBytes(record);
   pipe.Write(bytes,0,bytes.Length);pipe.Flush();
  }
  return 0;
 }
}
