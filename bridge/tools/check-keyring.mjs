// One-off check of the fixed PowerShell invocation used by agytoken.mjs
// for the Windows Credential keyring path. Mirrors loadKeyringBindings()
// exactly (same readerScript, same execFileSync arguments).
import { execFileSync } from 'node:child_process'

const readerScript = target => [
  'Add-Type -TypeDefinition @"',
  'using System; using System.Runtime.InteropServices;',
  'public static class C {',
  '  [StructLayout(LayoutKind.Sequential, CharSet=CharSet.Unicode)]',
  '  public struct CR { public int Flags; public int Type; [MarshalAs(UnmanagedType.LPWStr)] public string TargetName; [MarshalAs(UnmanagedType.LPWStr)] public string Comment; public long LastWritten; public int CredentialBlobSize; public IntPtr CredentialBlob; public int Persist; public int AttributeCount; public IntPtr Attributes; [MarshalAs(UnmanagedType.LPWStr)] public string TargetAlias; [MarshalAs(UnmanagedType.LPWStr)] public string UserName; }',
  '  [DllImport("advapi32.dll", SetLastError=true, CharSet=CharSet.Unicode)] public static extern bool CredRead(string t,int ty,int f,out IntPtr p);',
  '  [DllImport("advapi32.dll")] public static extern void CredFree(IntPtr p);',
  '  public static string R(string t){ IntPtr p; if(!CredRead(t,1,0,out p)) return null; try{ CR c=(CR)Marshal.PtrToStructure(p,typeof(CR)); byte[] b=new byte[c.CredentialBlobSize]; Marshal.Copy(c.CredentialBlob,b,0,b.Length); return System.Text.Encoding.UTF8.GetString(b);} finally{ CredFree(p);} }',
  '}',
  '"@',
  `$v = [C]::R(${JSON.stringify(target)}); if ($null -ne $v) { $v }`,
].join('\n')

function read(target) {
  const out = execFileSync('powershell.exe', ['-NoProfile', '-Command', readerScript(target)], {
    encoding: 'utf8',
    windowsHide: true,
    timeout: 20000,
    maxBuffer: 1024 * 64,
  })
  const value = out.trim()
  if (!value || value.includes('Add-Type -TypeDefinition')) return null
  return value
}

const a = read('gemini:antigravity')
console.log('real target ->', a === null
  ? 'NULL (no such credential)'
  : `OK ${a.length} chars; head=${JSON.stringify(a.slice(0, 30))}; parses=${(() => { try { JSON.parse(a); return true } catch { return false } })()}`)
const b = read('definitely-not-a-credential-target-xyz')
console.log('missing target ->', b === null ? 'NULL (clean)' : `UNEXPECTED ${JSON.stringify(b.slice(0, 60))}`)
