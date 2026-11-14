Set-StrictMode -Version Latest

# The callback runs only while both independently authenticated tokens are held.
# Backend and callback exceptions are mapped to fixed, non-sensitive reasons.
function Invoke-PhaseAAccountGate([bool]$Enabled, [hashtable]$Backend, [scriptblock]$UseTokens) {
  if (-not $Enabled) { return 'LIVE_DISABLED' }
  $accounts=New-Object 'System.Collections.Generic.List[object]'
  $tokens=New-Object 'System.Collections.Generic.List[object]'
  $reason='ACCOUNT_CREATION_FAILED'; $cleanupFailed=$false
  try {
    foreach ($role in @('broker','legacy')) {
      $account=& $Backend.Create $role
      if ($null -eq $account) { throw 'creation failure' }
      $accounts.Add($account)
      if ([string]::IsNullOrWhiteSpace([string]$account.sid)) { throw 'creation failure' }
    }
    $reason='ACCOUNT_IDENTITY_REJECTED'
    if ($accounts[0].sid -ceq $accounts[1].sid) { throw 'duplicate identity' }
    foreach ($account in $accounts) {
      $reason='ACCOUNT_AUTHENTICATION_FAILED'
      $token=& $Backend.Authenticate $account
      if ($null -eq $token) { throw 'authentication failure' }
      $tokens.Add($token)
      $reason='ACCOUNT_IDENTITY_REJECTED'
      if ($token.sid -cne $account.sid -or $token.primary -isnot [bool] -or -not $token.primary -or
          $token.admin -isnot [bool] -or $token.admin -or $token.elevated -isnot [bool] -or $token.elevated -or
          $token.standard -isnot [bool] -or -not $token.standard) { throw 'identity rejected' }
    }
    $reason='ACCOUNT_CONSUMER_FAILED'
    $null=& $UseTokens $accounts.ToArray() $tokens.ToArray()
    $reason='STAGE1_COMPLETE'
  } catch {
    $base=$_.Exception.GetBaseException()
    if (($base -is [ComponentModel.Win32Exception] -and $base.NativeErrorCode -in @(5,1314)) -or
        $base -is [UnauthorizedAccessException] -or $_.CategoryInfo.Category -eq 'PermissionDenied') { $reason='ACCOUNT_PRIVILEGE_UNAVAILABLE' }
    if ($base -is [ComponentModel.Win32Exception] -and $base.NativeErrorCode -eq 1385) { $reason='ACCOUNT_LOGON_RIGHT_UNAVAILABLE' }
    if ($base.Message -ceq 'ACCOUNT_CLEANUP_FAILED') { $reason='ACCOUNT_CLEANUP_FAILED' }
  } finally {
    for ($i=$tokens.Count-1; $i -ge 0; $i--) { try { $null=& $Backend.Close $tokens[$i] } catch { $cleanupFailed=$true } }
    for ($i=$accounts.Count-1; $i -ge 0; $i--) { try { $null=& $Backend.Remove $accounts[$i] } catch { $cleanupFailed=$true } }
  }
  if ($cleanupFailed) { return 'ACCOUNT_CLEANUP_FAILED' }
  return $reason
}

function New-PhaseAWindowsAccountBackend {
  if ([IntPtr]::Size -ne 8 -or -not (Get-Command New-LocalUser -ErrorAction SilentlyContinue) -or
      -not (Get-Command Get-LocalUser -ErrorAction SilentlyContinue) -or -not (Get-Command Remove-LocalUser -ErrorAction SilentlyContinue) -or
      -not (Get-Command Get-LocalGroupMember -ErrorAction SilentlyContinue) -or -not (Get-Command Add-LocalGroupMember -ErrorAction SilentlyContinue)) {
    throw 'ACCOUNT_MANAGEMENT_UNAVAILABLE'
  }
  if (-not ('EtherPhaseAAccountNative' -as [type])) {
    Add-Type -TypeDefinition @'
using System;
using System.Security;
using System.Security.Principal;
using System.Runtime.InteropServices;
using System.ComponentModel;
using Microsoft.Win32.SafeHandles;
public sealed class EtherPhaseAToken : SafeHandleZeroOrMinusOneIsInvalid {
  private EtherPhaseAToken() : base(true) { }
  [DllImport("kernel32.dll", SetLastError=true)] static extern bool CloseHandle(IntPtr handle);
  protected override bool ReleaseHandle() { return CloseHandle(handle); }
  public bool CloseChecked() {
    if (IsClosed || IsInvalid) return false;
    if (!CloseHandle(handle)) return false;
    SetHandleAsInvalid(); return true;
  }
}
public static class EtherPhaseAAccountNative {
  [DllImport("advapi32.dll", CharSet=CharSet.Unicode, SetLastError=true)]
  static extern bool LogonUserW(string user, string domain, IntPtr password, int type, int provider, out EtherPhaseAToken token);
  [DllImport("advapi32.dll", SetLastError=true)]
  static extern bool GetTokenInformation(EtherPhaseAToken token, int kind, out int value, int length, out int returned);
  public sealed class Result { public EtherPhaseAToken handle; public string sid; public bool primary, admin, elevated, standard; }
  public static Result Authenticate(string user, SecureString password) {
    IntPtr buffer=IntPtr.Zero; EtherPhaseAToken token=null;
    try {
      buffer=Marshal.SecureStringToGlobalAllocUnicode(password);
      if (!LogonUserW(user,".",buffer,2,0,out token)) throw new Win32Exception(Marshal.GetLastWin32Error());
      int type, elevation, len;
      if (!GetTokenInformation(token,8,out type,sizeof(int),out len)) throw new Win32Exception(Marshal.GetLastWin32Error());
      if (!GetTokenInformation(token,20,out elevation,sizeof(int),out len)) throw new Win32Exception(Marshal.GetLastWin32Error());
      using (WindowsIdentity identity=new WindowsIdentity(token.DangerousGetHandle())) {
        bool admin=false, standard=false;
        foreach (IdentityReference group in identity.Groups) {
          if (group.Value=="S-1-5-32-544") admin=true;
          if (group.Value=="S-1-5-32-545") standard=true;
        }
        Result r=new Result { handle=token, sid=identity.User.Value, primary=type==1, admin=admin, elevated=elevation!=0, standard=standard };
        token=null; return r;
      }
    } finally {
      if (buffer!=IntPtr.Zero) Marshal.ZeroFreeGlobalAllocUnicode(buffer);
      if (token!=null) token.Dispose();
    }
  }
}
'@
  }
  return @{
    Create={ param($role)
      $name='oa'+[Guid]::NewGuid().ToString('N').Substring(0,16)
      $description='ether-phase-a-'+[Guid]::NewGuid().ToString('N')
      $secret=New-Object Security.SecureString
      $random=New-Object byte[] 32; $rng=[Security.Cryptography.RandomNumberGenerator]::Create()
      $created=$null
      try {
        $rng.GetBytes($random)
        foreach ($c in 'Aa1!'.ToCharArray()) { $secret.AppendChar($c) }
        $alphabet='abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789'
        foreach ($b in $random) { $secret.AppendChar($alphabet[[int]$b % $alphabet.Length]) }
        $secret.MakeReadOnly()
        if (@(Get-LocalUser -ErrorAction Stop | Where-Object { $_.Name -ceq $name }).Count -ne 0) { throw 'account collision' }
        $created=New-LocalUser -Name $name -Password $secret -Description $description -ErrorAction Stop
        if ($null -eq $created -or $null -eq $created.SID) { throw 'account SID unavailable' }
        $usersSid=New-Object Security.Principal.SecurityIdentifier('S-1-5-32-545')
        $members=@(Get-LocalGroupMember -SID $usersSid -ErrorAction Stop)
        if (@($members | Where-Object { $_.SID.Value -ceq $created.SID.Value }).Count -eq 0) {
          Add-LocalGroupMember -SID $usersSid -Member $created.SID -ErrorAction Stop
        }
        $members=@(Get-LocalGroupMember -SID $usersSid -ErrorAction Stop)
        if (@($members | Where-Object { $_.SID.Value -ceq $created.SID.Value }).Count -ne 1) { throw 'standard membership not confirmed' }
        return @{ role=$role; name=$name; sid=$created.SID.Value; description=$description; secret=$secret }
      } catch {
        $cleanupError=$false
        try {
          $found=Get-LocalUser -ErrorAction Stop | Where-Object { $_.Name -ceq $name }
          if ($found -and $found.Description -ceq $description) { Remove-LocalUser -SID $found.SID -ErrorAction Stop }
        } catch { $cleanupError=$true }
        $secret.Dispose()
        if ($cleanupError) { throw 'ACCOUNT_CLEANUP_FAILED' }
        throw
      } finally { $rng.Dispose(); [Array]::Clear($random,0,$random.Length) }
    }
    Authenticate={ param($account)
      try { return [EtherPhaseAAccountNative]::Authenticate($account.name,$account.secret) }
      finally { $account.secret.Dispose() }
    }
    Close={ param($token)
      try { if (-not $token.handle.CloseChecked()) { throw 'token handle cleanup failed' } }
      finally { $token.handle.Dispose() }
    }
    Remove={ param($account)
      try {
        $found=Get-LocalUser -ErrorAction Stop | Where-Object { $_.Name -ceq $account.name }
        if ($found) {
          if ($found.SID.Value -cne $account.sid -or $found.Description -cne $account.description) { throw 'account ownership mismatch' }
          Remove-LocalUser -SID $found.SID -ErrorAction Stop
          if (@(Get-LocalUser -ErrorAction Stop | Where-Object { $_.SID.Value -ceq $account.sid }).Count -ne 0) { throw 'account removal not confirmed' }
        }
      } finally { $account.secret.Dispose() }
    }
  }
}
