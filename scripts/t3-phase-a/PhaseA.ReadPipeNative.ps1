Set-StrictMode -Version Latest
if(-not ('PhaseAReadPipeNative' -as [type])) {
 Add-Type -TypeDefinition @"
using System;
using System.Runtime.InteropServices;
using Microsoft.Win32.SafeHandles;
public static class PhaseAReadPipeNative {
 [DllImport("kernel32.dll",SetLastError=true)] static extern bool GetNamedPipeClientProcessId(SafePipeHandle h,out uint pid);
 public static uint ClientPid(SafePipeHandle h) { uint p; if(!GetNamedPipeClientProcessId(h,out p)) throw new System.ComponentModel.Win32Exception(Marshal.GetLastWin32Error()); return p; }
}
"@
}
