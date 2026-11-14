Set-StrictMode -Version Latest
# Returns only a digest; the raw names and security descriptors remain local.
# Reject reparse points before descending, so the traversal cannot intentionally
# leave the protected tree. This helper is not a substitute for an ACL audit.
function Get-PhaseAInventory([string]$Root) {
  $rootPath = [IO.Path]::GetFullPath($Root).TrimEnd([IO.Path]::DirectorySeparatorChar)
  if (-not [IO.Directory]::Exists($rootPath)) { throw 'Inventory root unavailable' }
  $pending = New-Object 'System.Collections.Generic.Stack[string]'
  $records = New-Object 'System.Collections.Generic.List[string]'
  $pending.Push($rootPath)
  while ($pending.Count -gt 0) {
    $path = $pending.Pop()
    $item = Get-Item -LiteralPath $path -Force -ErrorAction Stop
    if (($item.Attributes -band [IO.FileAttributes]::ReparsePoint) -ne 0) { throw 'Inventory contains a reparse point' }
    $isDirectory = ($item.Attributes -band [IO.FileAttributes]::Directory) -ne 0
    $relative = if ($path -ceq $rootPath) { '.' } else { $path.Substring($rootPath.Length + 1).Replace('\','/') }
    $name = [Convert]::ToBase64String([Text.Encoding]::UTF8.GetBytes($relative))
    $sddl = (Get-Acl -LiteralPath $path -ErrorAction Stop).GetSecurityDescriptorSddlForm([Security.AccessControl.AccessControlSections]'Owner, Group, Access')
    $encodedAcl = [Convert]::ToBase64String([Text.Encoding]::UTF8.GetBytes($sddl))
    if ($isDirectory) {
      $records.Add("D|$name|$encodedAcl")
      foreach ($child in [IO.Directory]::EnumerateFileSystemEntries($path)) { $pending.Push($child) }
    } else {
      $stream = [IO.File]::Open($path, [IO.FileMode]::Open, [IO.FileAccess]::Read, [IO.FileShare]::Read)
      try {
        $size = $stream.Length
        $sha = [Security.Cryptography.SHA256]::Create()
        try { $hash = [BitConverter]::ToString($sha.ComputeHash($stream)).Replace('-','').ToLowerInvariant() } finally { $sha.Dispose() }
      } finally { $stream.Dispose() }
      $records.Add("F|$name|$size|$hash|$encodedAcl")
    }
  }
  [string[]]$ordered = $records.ToArray()
  [Array]::Sort($ordered, [StringComparer]::Ordinal)
  $bytes = [Text.Encoding]::UTF8.GetBytes(($ordered -join "`n"))
  $sha = [Security.Cryptography.SHA256]::Create()
  try { return [BitConverter]::ToString($sha.ComputeHash($bytes)).Replace('-','').ToLowerInvariant() } finally { $sha.Dispose() }
}
