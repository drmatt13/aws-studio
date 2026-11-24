# Native Windows process-tree ownership for trusted host commands. No command is interpreted
# by PowerShell: the private environment value contains a file and argv as JSON.
$ErrorActionPreference = 'Stop'
try {
  $spec = $env:FRAMEWORK_STUDIO_WINDOWS_JOB_COMMAND | ConvertFrom-Json
  [Environment]::SetEnvironmentVariable('FRAMEWORK_STUDIO_WINDOWS_JOB_COMMAND', $null)
  if (!$spec.file -or !$spec.parentPid) { throw 'Missing process specification' }
  $sourceCode = @'
using System;
using System.Collections;
using System.ComponentModel;
using System.Runtime.InteropServices;
using System.Text;

public static class StudioWindowsJob {
  [StructLayout(LayoutKind.Sequential)] struct BasicLimits {
    public long ProcessTime, JobTime;
    public uint Flags;
    public UIntPtr MinWorkingSet, MaxWorkingSet;
    public uint ActiveProcesses;
    public UIntPtr Affinity;
    public uint Priority, Scheduling;
  }
  [StructLayout(LayoutKind.Sequential)] struct IoCounters {
    public ulong ReadOperations, WriteOperations, OtherOperations, ReadBytes, WriteBytes, OtherBytes;
  }
  [StructLayout(LayoutKind.Sequential)] struct ExtendedLimits {
    public BasicLimits Basic;
    public IoCounters Io;
    public UIntPtr ProcessMemory, JobMemory, PeakProcessMemory, PeakJobMemory;
  }
  [StructLayout(LayoutKind.Sequential, CharSet = CharSet.Unicode)] struct StartupInfo {
    public int Size;
    public string Reserved, Desktop, Title;
    public uint X, Y, XSize, YSize, XCount, YCount, FillAttribute, Flags;
    public short ShowWindow, ReservedBytes;
    public IntPtr ReservedPointer, Input, Output, Error;
  }
  [StructLayout(LayoutKind.Sequential)] struct ProcessInfo { public IntPtr Process, Thread; public uint Pid, Tid; }
  [DllImport("kernel32.dll", CharSet = CharSet.Unicode, SetLastError = true)] static extern IntPtr CreateJobObject(IntPtr security, string name);
  [DllImport("kernel32.dll", SetLastError = true)] static extern bool SetInformationJobObject(IntPtr job, int kind, ref ExtendedLimits limits, int size);
  [DllImport("kernel32.dll", SetLastError = true)] static extern bool AssignProcessToJobObject(IntPtr job, IntPtr process);
  [DllImport("kernel32.dll", CharSet = CharSet.Unicode, SetLastError = true)] static extern bool CreateProcess(string application, StringBuilder command, IntPtr processSecurity, IntPtr threadSecurity, bool inherit, uint flags, IntPtr environment, string directory, ref StartupInfo startup, out ProcessInfo info);
  [DllImport("kernel32.dll", SetLastError = true)] static extern uint ResumeThread(IntPtr thread);
  [DllImport("kernel32.dll", SetLastError = true)] static extern bool TerminateProcess(IntPtr process, uint code);
  [DllImport("kernel32.dll", SetLastError = true)] static extern bool GetExitCodeProcess(IntPtr process, out uint code);
  [DllImport("kernel32.dll", SetLastError = true)] static extern IntPtr OpenProcess(uint access, bool inherit, int pid);
  [DllImport("kernel32.dll", SetLastError = true)] static extern bool GetProcessTimes(IntPtr process, out long created, out long exited, out long kernel, out long user);
  [DllImport("kernel32.dll")] static extern IntPtr GetCurrentProcess();
  [DllImport("kernel32.dll")] static extern IntPtr GetStdHandle(int kind);
  [DllImport("kernel32.dll", SetLastError = true)] static extern bool SetHandleInformation(IntPtr handle, uint mask, uint flags);
  [DllImport("kernel32.dll", SetLastError = true)] static extern uint WaitForSingleObject(IntPtr handle, uint timeout);
  [DllImport("kernel32.dll", SetLastError = true)] static extern uint WaitForMultipleObjects(uint count, IntPtr[] handles, bool all, uint timeout);
  [DllImport("kernel32.dll")] static extern bool CloseHandle(IntPtr handle);

  static void Check(bool success) { if (!success) throw new Win32Exception(Marshal.GetLastWin32Error()); }
  static void CheckParent(IntPtr parent) {
    uint state = WaitForSingleObject(parent, 0);
    if (state == 0x00000102) return; // WAIT_TIMEOUT: the parent is still alive.
    if (state == 0) throw new InvalidOperationException("Tether parent exited.");
    throw new Win32Exception(Marshal.GetLastWin32Error());
  }
  // CommandLineToArgvW / C-runtime escaping. Quotes and metacharacters stay data;
  // trailing backslashes must be doubled before the closing argument quote.
  static string Quote(string value) {
    StringBuilder output = new StringBuilder("\"");
    int slashes = 0;
    foreach (char c in value) {
      if (c == '\\') { slashes++; continue; }
      output.Append('\\', c == '"' ? slashes * 2 + 1 : slashes);
      output.Append(c);
      slashes = 0;
    }
    output.Append('\\', slashes * 2);
    return output.Append('"').ToString();
  }

  public static int Run(string file, string[] args, int parentPid, IDictionary temporary) {
    IntPtr job = IntPtr.Zero, parent = IntPtr.Zero, environment = IntPtr.Zero;
    ProcessInfo process = new ProcessInfo();
    try {
      // Hold a kernel handle to the actual tether parent. Comparing creation
      // times refuses a PID already reused after this host was created.
      parent = OpenProcess(0x00101000, false, parentPid); // SYNCHRONIZE | QUERY_LIMITED_INFORMATION
      if (parent == IntPtr.Zero) throw new Win32Exception(Marshal.GetLastWin32Error());
      long parentCreated, ownCreated, unused1, unused2, unused3;
      Check(GetProcessTimes(parent, out parentCreated, out unused1, out unused2, out unused3));
      Check(GetProcessTimes(GetCurrentProcess(), out ownCreated, out unused1, out unused2, out unused3));
      if (parentCreated > ownCreated) throw new InvalidOperationException("Tether parent identity changed.");
      job = CreateJobObject(IntPtr.Zero, null);
      if (job == IntPtr.Zero) throw new Win32Exception(Marshal.GetLastWin32Error());
      ExtendedLimits limits = new ExtendedLimits();
      limits.Basic.Flags = 0x00002000; // JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE
      Check(SetInformationJobObject(job, 9, ref limits, Marshal.SizeOf(typeof(ExtendedLimits))));
      StartupInfo startup = new StartupInfo();
      startup.Size = Marshal.SizeOf(typeof(StartupInfo));
      startup.Flags = 0x00000100; // STARTF_USESTDHANDLES
      startup.Input = GetStdHandle(-10); startup.Output = GetStdHandle(-11); startup.Error = GetStdHandle(-12);
      Check(SetHandleInformation(startup.Input, 1, 1));
      Check(SetHandleInformation(startup.Output, 1, 1));
      Check(SetHandleInformation(startup.Error, 1, 1));
      StringBuilder command = new StringBuilder(Quote(file));
      foreach (string arg in args) command.Append(' ').Append(Quote(arg));
      // Keep the supervisor's own TEMP short. Pass the declared child values
      // in an explicit Unicode environment block rather than mutating this
      // legacy CLR process before CreateProcess performs its own initialization.
      SortedList variables = new SortedList(StringComparer.OrdinalIgnoreCase);
      foreach (DictionaryEntry entry in Environment.GetEnvironmentVariables()) variables[(string)entry.Key] = entry.Value;
      foreach (DictionaryEntry entry in temporary) {
        if (entry.Value == null) variables.Remove(entry.Key);
        else variables[(string)entry.Key] = (string)entry.Value;
      }
      StringBuilder block = new StringBuilder();
      foreach (DictionaryEntry entry in variables) block.Append((string)entry.Key).Append('=').Append((string)entry.Value).Append('\0');
      block.Append('\0');
      environment = Marshal.StringToHGlobalUni(block.ToString());
      // Assignment happens while suspended: no user command can spawn an
      // unowned descendant before joining the job. Failure never runs it.
      CheckParent(parent);
      if (!CreateProcess(null, command, IntPtr.Zero, IntPtr.Zero, true, 0x08000404, environment, null, ref startup, out process)) {
        int error = Marshal.GetLastWin32Error();
        if (error == 2 || error == 3) {
          Console.Error.WriteLine("The requested executable was not found (ENOENT).");
          return 127;
        }
        throw new Win32Exception(error);
      }
      Check(AssignProcessToJobObject(job, process.Process));
      CheckParent(parent);
      if (ResumeThread(process.Thread) == 0xffffffff) throw new Win32Exception(Marshal.GetLastWin32Error());
      uint result = WaitForMultipleObjects(2, new IntPtr[] { process.Process, parent }, false, 0xffffffff);
      if (result == 1) return 1; // Parent died; closing the job ends its whole tree.
      if (result != 0) throw new Win32Exception(Marshal.GetLastWin32Error());
      uint code;
      Check(GetExitCodeProcess(process.Process, out code));
      return unchecked((int)code);
    } finally {
      // Also terminate a suspended child if assignment or setup failed.
      if (process.Process != IntPtr.Zero) { TerminateProcess(process.Process, 1); CloseHandle(process.Process); }
      if (process.Thread != IntPtr.Zero) CloseHandle(process.Thread);
      if (job != IntPtr.Zero) CloseHandle(job);
      if (parent != IntPtr.Zero) CloseHandle(parent);
      if (environment != IntPtr.Zero) Marshal.FreeHGlobal(environment);
    }
  }
}
'@
  # Windows PowerShell 5's Add-Type writes compiler response files using a
  # legacy code page, corrupting non-ASCII TEMP paths. Start the installed .NET
  # compiler directly with Unicode arguments and a fixed runtime working directory.
  # The launcher selects a short supervisor TEMP and restores the child's TEMP.
  # Known-folder expansion follows USERPROFILE overrides used for isolated homes.
  # Protect our unique compiler child before writing any source or assembly.
  $compilerRoot = $env:TEMP
  if (-not [IO.Path]::IsPathRooted($compilerRoot) -or -not [IO.Directory]::Exists($compilerRoot)) { throw 'Native compiler temporary root is unavailable' }
  $compilerDirectory = [IO.Path]::Combine($compilerRoot, 'aws-studio-job-' + [Guid]::NewGuid().ToString())
  $sid = [Security.Principal.WindowsIdentity]::GetCurrent().User
  $acl = New-Object Security.AccessControl.DirectorySecurity
  $acl.SetOwner($sid)
  $acl.SetAccessRuleProtection($true, $false)
  $acl.AddAccessRule((New-Object Security.AccessControl.FileSystemAccessRule($sid, 'FullControl', 'ContainerInherit,ObjectInherit', 'None', 'Allow')))
  if ([IO.Directory]::Exists($compilerDirectory)) { throw 'Compiler directory already exists' }
  [void][IO.Directory]::CreateDirectory($compilerDirectory, $acl)
  $actualAcl = [IO.Directory]::GetAccessControl($compilerDirectory)
  if ($actualAcl.GetOwner([Security.Principal.SecurityIdentifier]).Value -ne $sid.Value -or ([IO.File]::GetAttributes($compilerDirectory) -band [IO.FileAttributes]::ReparsePoint) -ne 0) { throw 'Compiler directory changed identity' }
  foreach ($rule in $actualAcl.GetAccessRules($true, $true, [Security.Principal.SecurityIdentifier])) {
    if ($rule.AccessControlType -eq 'Allow' -and $rule.IdentityReference.Value -ne $sid.Value) { throw 'Compiler directory is shared' }
  }
  $sourceFile = [IO.Path]::Combine($compilerDirectory, 'supervisor.cs')
  $assembly = [IO.Path]::Combine($compilerDirectory, 'supervisor.dll')
  try {
    $stream = [IO.File]::Open($sourceFile, [IO.FileMode]::CreateNew, [IO.FileAccess]::Write, [IO.FileShare]::None)
    $writer = New-Object IO.StreamWriter($stream)
    try { $writer.Write($sourceCode) } finally { $writer.Dispose() }
    $compiler = [IO.Path]::Combine([Runtime.InteropServices.RuntimeEnvironment]::GetRuntimeDirectory(), 'csc.exe')
    $start = New-Object Diagnostics.ProcessStartInfo
    $start.FileName = $compiler
    $start.Arguments = '/nologo /target:library /out:"' + $assembly + '" "' + $sourceFile + '"'
    $start.WorkingDirectory = [IO.Path]::GetDirectoryName($compiler)
    $start.UseShellExecute = $false
    $start.CreateNoWindow = $true
    $start.RedirectStandardOutput = $true
    $start.RedirectStandardError = $true
    $start.EnvironmentVariables['TEMP'] = $compilerDirectory
    $start.EnvironmentVariables['TMP'] = $compilerDirectory
    $compile = [Diagnostics.Process]::Start($start)
    try {
      $stdout = $compile.StandardOutput.ReadToEndAsync()
      $stderr = $compile.StandardError.ReadToEndAsync()
      if (-not $compile.WaitForExit(10000)) { $compile.Kill(); $null = $compile.WaitForExit(1000); throw 'Native compiler timed out' }
      $null = $stdout.GetAwaiter().GetResult()
      $null = $stderr.GetAwaiter().GetResult()
      if ($compile.ExitCode -ne 0) { throw 'Native compiler failed' }
      # Load bytes instead of a path so cleanup can remove both temporary files.
      $nativeAssembly = [Reflection.Assembly]::Load([IO.File]::ReadAllBytes($assembly))
    } finally { $compile.Dispose() }
  } finally {
    [IO.File]::Delete($sourceFile)
    [IO.File]::Delete($assembly)
    # Remove only our two known files and their empty child, never a recursive
    # temporary-directory purge or another process's compiler artifacts.
    [IO.Directory]::Delete($compilerDirectory)
  }
  $temporary = @{}
  if ($null -ne $spec.temporary) {
    foreach ($name in @('TEMP', 'TMP', 'TMPDIR', 'SystemRoot', 'WINDIR', 'LOCALAPPDATA', 'USERPROFILE', 'PSModulePath', 'PSExecutionPolicyPreference', 'PATHEXT')) { $temporary[$name] = $spec.temporary.$name }
  }
  exit [StudioWindowsJob]::Run([string]$spec.file, [string[]]@($spec.args), [int]$spec.parentPid, $temporary)
} catch {
  # Native errors may contain executable paths. Keep the public failure fixed.
  [Console]::Error.WriteLine('The Windows process job could not start or supervise its command. Check Windows PowerShell, .NET Framework and local TEMP write permissions; inspect the operation before retrying.')
  exit 127
}
