#requires -Version 7.5

[CmdletBinding()]
param(
    [Parameter(Mandatory = $true)]
    [ValidateSet("Validate", "Start", "Status", "ResumePublication", "Supervise")]
    [string]$Mode,

    [Parameter(Mandatory = $true)]
    [string]$ManifestPath,

    [Parameter(Mandatory = $true)]
    [string]$ExpectedManifestSha256,

    [string]$TicketPath,

    # Supervise is an internal, ticket-bound entry point. The nonce is not a
    # credential; it prevents an unrelated process from claiming a launch.
    [string]$LaunchNonce,

    # Supervise is bound to the immutable pre-launch admission.  The child
    # publishes its own ticket only after validating this exact artifact.
    [string]$LaunchAdmissionPath,

    [string]$ExpectedLaunchAdmissionSha256,

    [ValidateRange(1, 2100)]
    [int]$SupervisorTimeoutSeconds = 2100
)

Set-StrictMode -Version Latest
$ErrorActionPreference = "Stop"

$script:RepositoryRoot = [IO.Path]::GetFullPath((Join-Path $PSScriptRoot "..\.."))
$script:SelfPath = [IO.Path]::GetFullPath($PSCommandPath)
$script:WorkerPath = [IO.Path]::GetFullPath((Join-Path $PSScriptRoot "refresh-and-snapshot-fixtures.ps1"))
$script:ManifestType = "waf800_diagnostic_prep_manifest"
$script:ManifestVersion = "waf800-diagnostic-prep-manifest-v1"
$script:SupervisorVersion = "diagnostic-prep-supervisor-v1"
$script:TicketVersion = "diagnostic-prep-supervisor-ticket-v2"
$script:LaunchAdmissionVersion = "diagnostic-prep-supervisor-launch-admission-v1"
$script:LaunchPresenceVersion = "diagnostic-prep-supervisor-launch-presence-v1"
$script:RecoveryAdmissionVersion = "diagnostic-prep-publication-recovery-admission-v1"
$script:RecoveryReceiptVersion = "fixture-publication-recovery-v1"
$script:RunLockVersion = "diagnostic-prep-supervisor-run-lock-v1"
$script:JournalVersion = "diagnostic-prep-journal-v1"
$script:DefaultTimeoutSeconds = 2100
$script:WorkerOwnershipVersion = "diagnostic-prep-worker-job-v1"
$script:FailureDetailStage = $null

if (-not ("SchoolPilot.DiagnosticPrep.JobNative" -as [type])) {
    Add-Type -TypeDefinition @'
using System;
using System.ComponentModel;
using System.Runtime.InteropServices;
using System.Text;

namespace SchoolPilot.DiagnosticPrep {
    public sealed class BoundProcessLaunch : IDisposable {
        public uint ProcessId { get; private set; }
        public string StartedAtUtc { get; private set; }
        public string ImagePath { get; private set; }
        private IntPtr processHandle;
        private IntPtr threadHandle;
        private bool resumed;
        private bool disposed;

        internal BoundProcessLaunch(uint processId, IntPtr processHandle, IntPtr threadHandle,
                string startedAtUtc, string imagePath) {
            ProcessId = processId;
            StartedAtUtc = startedAtUtc;
            ImagePath = imagePath;
            this.processHandle = processHandle;
            this.threadHandle = threadHandle;
        }

        public void Resume() {
            if (disposed || resumed || threadHandle == IntPtr.Zero) {
                throw new InvalidOperationException("The bound preparation worker cannot be resumed twice.");
            }
            uint previous = JobNative.ResumeThread(threadHandle);
            if (previous == UInt32.MaxValue) {
                throw new Win32Exception(Marshal.GetLastWin32Error(),
                    "Unable to resume the Job-bound preparation worker.");
            }
            if (previous != 1) {
                throw new InvalidOperationException(
                    "The Job-bound preparation worker had an unexpected suspend count.");
            }
            resumed = true;
            JobNative.CloseHandle(threadHandle);
            threadHandle = IntPtr.Zero;
        }

        public void Dispose() {
            if (disposed) return;
            disposed = true;
            if (!resumed && processHandle != IntPtr.Zero) {
                JobNative.TerminateProcess(processHandle, 1);
                JobNative.WaitForSingleObject(processHandle, 10000);
            }
            if (threadHandle != IntPtr.Zero) JobNative.CloseHandle(threadHandle);
            if (processHandle != IntPtr.Zero) JobNative.CloseHandle(processHandle);
            threadHandle = IntPtr.Zero;
            processHandle = IntPtr.Zero;
        }
    }

    public static class JobNative {
        private const uint GENERIC_READ = 0x80000000;
        private const uint GENERIC_WRITE = 0x40000000;
        private const uint FILE_SHARE_READ = 0x00000001;
        private const uint FILE_SHARE_WRITE = 0x00000002;
        private const uint FILE_SHARE_DELETE = 0x00000004;
        private const uint OPEN_EXISTING = 3;
        private const uint FILE_ATTRIBUTE_NORMAL = 0x00000080;
        private const uint STARTF_USESTDHANDLES = 0x00000100;
        private const uint CREATE_SUSPENDED = 0x00000004;
        private const uint CREATE_NO_WINDOW = 0x08000000;
        private const uint EXTENDED_STARTUPINFO_PRESENT = 0x00080000;
        private const long PROC_THREAD_ATTRIBUTE_HANDLE_LIST = 0x00020002;
        private const long PROC_THREAD_ATTRIBUTE_JOB_LIST = 0x0002000D;
        private static readonly IntPtr InvalidHandle = new IntPtr(-1);

        [StructLayout(LayoutKind.Sequential)]
        public struct SecurityAttributes {
            public int Length;
            public IntPtr SecurityDescriptor;
            [MarshalAs(UnmanagedType.Bool)] public bool InheritHandle;
        }

        [StructLayout(LayoutKind.Sequential, CharSet = CharSet.Unicode)]
        public struct StartupInfo {
            public int Size;
            public string Reserved;
            public string Desktop;
            public string Title;
            public int X, Y, XSize, YSize, XCountChars, YCountChars;
            public int FillAttribute;
            public int Flags;
            public short ShowWindow;
            public short Reserved2Length;
            public IntPtr Reserved2;
            public IntPtr StdInput;
            public IntPtr StdOutput;
            public IntPtr StdError;
        }

        [StructLayout(LayoutKind.Sequential)]
        public struct StartupInfoEx {
            public StartupInfo StartupInfo;
            public IntPtr AttributeList;
        }

        [StructLayout(LayoutKind.Sequential)]
        public struct ProcessInformation {
            public IntPtr Process;
            public IntPtr Thread;
            public uint ProcessId;
            public uint ThreadId;
        }

        [StructLayout(LayoutKind.Sequential)]
        public struct FileTime {
            public uint Low;
            public uint High;
        }

        [StructLayout(LayoutKind.Sequential)]
        public struct IoCounters {
            public ulong ReadOperationCount, WriteOperationCount, OtherOperationCount;
            public ulong ReadTransferCount, WriteTransferCount, OtherTransferCount;
        }

        [StructLayout(LayoutKind.Sequential)]
        public struct BasicLimitInformation {
            public long PerProcessUserTimeLimit, PerJobUserTimeLimit;
            public uint LimitFlags;
            public UIntPtr MinimumWorkingSetSize, MaximumWorkingSetSize;
            public uint ActiveProcessLimit;
            public UIntPtr Affinity;
            public uint PriorityClass, SchedulingClass;
        }

        [StructLayout(LayoutKind.Sequential)]
        public struct ExtendedLimitInformation {
            public BasicLimitInformation BasicLimitInformation;
            public IoCounters IoInfo;
            public UIntPtr ProcessMemoryLimit, JobMemoryLimit;
            public UIntPtr PeakProcessMemoryUsed, PeakJobMemoryUsed;
        }

        [DllImport("kernel32.dll", CharSet = CharSet.Unicode, SetLastError = true)]
        public static extern IntPtr CreateJobObject(IntPtr securityAttributes, string name);

        [DllImport("kernel32.dll", SetLastError = true)]
        public static extern bool SetInformationJobObject(
            IntPtr job, int informationClass, IntPtr information, uint informationLength);

        [DllImport("kernel32.dll", SetLastError = true)]
        public static extern bool IsProcessInJob(IntPtr process, IntPtr job, out bool result);

        [DllImport("kernel32.dll", SetLastError = true)]
        public static extern bool CloseHandle(IntPtr handle);

        [DllImport("kernel32.dll", CharSet = CharSet.Unicode, SetLastError = true)]
        private static extern IntPtr CreateFile(
            string fileName, uint desiredAccess, uint shareMode,
            ref SecurityAttributes securityAttributes, uint creationDisposition,
            uint flagsAndAttributes, IntPtr templateFile);

        [DllImport("kernel32.dll", SetLastError = true)]
        private static extern bool InitializeProcThreadAttributeList(
            IntPtr attributeList, int attributeCount, int flags, ref IntPtr size);

        [DllImport("kernel32.dll", SetLastError = true)]
        private static extern bool UpdateProcThreadAttribute(
            IntPtr attributeList, uint flags, IntPtr attribute, IntPtr value,
            IntPtr size, IntPtr previousValue, IntPtr returnSize);

        [DllImport("kernel32.dll")]
        private static extern void DeleteProcThreadAttributeList(IntPtr attributeList);

        [DllImport("kernel32.dll", CharSet = CharSet.Unicode, SetLastError = true)]
        private static extern bool CreateProcessW(
            string applicationName, StringBuilder commandLine,
            IntPtr processAttributes, IntPtr threadAttributes,
            [MarshalAs(UnmanagedType.Bool)] bool inheritHandles,
            uint creationFlags, IntPtr environment, string currentDirectory,
            ref StartupInfoEx startupInfo, out ProcessInformation processInformation);

        [DllImport("kernel32.dll", SetLastError = true)]
        internal static extern uint ResumeThread(IntPtr thread);

        [DllImport("kernel32.dll", SetLastError = true)]
        [return: MarshalAs(UnmanagedType.Bool)]
        internal static extern bool TerminateProcess(IntPtr process, uint exitCode);

        [DllImport("kernel32.dll", SetLastError = true)]
        internal static extern uint WaitForSingleObject(IntPtr handle, uint milliseconds);

        [DllImport("kernel32.dll", SetLastError = true)]
        [return: MarshalAs(UnmanagedType.Bool)]
        private static extern bool GetProcessTimes(
            IntPtr process, out FileTime creation, out FileTime exit,
            out FileTime kernel, out FileTime user);

        public static BoundProcessLaunch CreateSuspendedProcessInJob(
            string executablePath, string commandLine, string currentDirectory,
            string stdoutPath, string stderrPath, IntPtr jobHandle) {
            if (jobHandle == IntPtr.Zero) throw new ArgumentException("A Job Object is required.");
            SecurityAttributes inheritable = new SecurityAttributes {
                Length = Marshal.SizeOf<SecurityAttributes>(),
                SecurityDescriptor = IntPtr.Zero,
                InheritHandle = true
            };
            IntPtr stdin = IntPtr.Zero, stdout = IntPtr.Zero, stderr = IntPtr.Zero;
            IntPtr attributeList = IntPtr.Zero, handleList = IntPtr.Zero, jobList = IntPtr.Zero;
            ProcessInformation process = new ProcessInformation();
            bool created = false, handedOff = false;
            try {
                uint share = FILE_SHARE_READ | FILE_SHARE_WRITE | FILE_SHARE_DELETE;
                stdin = CreateFile("NUL", GENERIC_READ, share, ref inheritable,
                    OPEN_EXISTING, FILE_ATTRIBUTE_NORMAL, IntPtr.Zero);
                stdout = CreateFile(stdoutPath, GENERIC_WRITE, share, ref inheritable,
                    OPEN_EXISTING, FILE_ATTRIBUTE_NORMAL, IntPtr.Zero);
                stderr = CreateFile(stderrPath, GENERIC_WRITE, share, ref inheritable,
                    OPEN_EXISTING, FILE_ATTRIBUTE_NORMAL, IntPtr.Zero);
                if (stdin == InvalidHandle || stdout == InvalidHandle || stderr == InvalidHandle) {
                    throw new Win32Exception(Marshal.GetLastWin32Error(),
                        "Unable to open the preparation worker standard streams.");
                }

                IntPtr attributeBytes = IntPtr.Zero;
                InitializeProcThreadAttributeList(IntPtr.Zero, 2, 0, ref attributeBytes);
                if (attributeBytes == IntPtr.Zero) {
                    throw new Win32Exception(Marshal.GetLastWin32Error(),
                        "Unable to size the preparation worker attribute list.");
                }
                attributeList = Marshal.AllocHGlobal(attributeBytes);
                if (!InitializeProcThreadAttributeList(attributeList, 2, 0, ref attributeBytes)) {
                    throw new Win32Exception(Marshal.GetLastWin32Error(),
                        "Unable to initialize the preparation worker attribute list.");
                }
                handleList = Marshal.AllocHGlobal(IntPtr.Size * 3);
                Marshal.WriteIntPtr(handleList, 0, stdin);
                Marshal.WriteIntPtr(handleList, IntPtr.Size, stdout);
                Marshal.WriteIntPtr(handleList, IntPtr.Size * 2, stderr);
                jobList = Marshal.AllocHGlobal(IntPtr.Size);
                Marshal.WriteIntPtr(jobList, jobHandle);
                if (!UpdateProcThreadAttribute(attributeList, 0,
                        new IntPtr(PROC_THREAD_ATTRIBUTE_HANDLE_LIST), handleList,
                        new IntPtr(IntPtr.Size * 3), IntPtr.Zero, IntPtr.Zero) ||
                    !UpdateProcThreadAttribute(attributeList, 0,
                        new IntPtr(PROC_THREAD_ATTRIBUTE_JOB_LIST), jobList,
                        new IntPtr(IntPtr.Size), IntPtr.Zero, IntPtr.Zero)) {
                    throw new Win32Exception(Marshal.GetLastWin32Error(),
                        "Unable to bind the preparation worker launch attributes.");
                }

                StartupInfoEx startup = new StartupInfoEx();
                startup.StartupInfo.Size = Marshal.SizeOf<StartupInfoEx>();
                startup.StartupInfo.Flags = (int)STARTF_USESTDHANDLES;
                startup.StartupInfo.StdInput = stdin;
                startup.StartupInfo.StdOutput = stdout;
                startup.StartupInfo.StdError = stderr;
                startup.AttributeList = attributeList;
                uint flags = CREATE_SUSPENDED | CREATE_NO_WINDOW | EXTENDED_STARTUPINFO_PRESENT;
                if (!CreateProcessW(executablePath, new StringBuilder(commandLine),
                        IntPtr.Zero, IntPtr.Zero, true, flags, IntPtr.Zero,
                        currentDirectory, ref startup, out process)) {
                    throw new Win32Exception(Marshal.GetLastWin32Error(),
                        "Unable to create the suspended preparation worker.");
                }
                created = true;
                bool inJob;
                if (!IsProcessInJob(process.Process, jobHandle, out inJob) || !inJob) {
                    throw new Win32Exception(Marshal.GetLastWin32Error(),
                        "The suspended preparation worker was not atomically Job-bound.");
                }
                FileTime creation, exit, kernel, user;
                if (!GetProcessTimes(process.Process, out creation, out exit, out kernel, out user)) {
                    throw new Win32Exception(Marshal.GetLastWin32Error(),
                        "Unable to capture the suspended preparation worker creation time.");
                }
                long creationFileTime = ((long)creation.High << 32) | creation.Low;
                string startedAtUtc = new DateTimeOffset(
                    DateTime.FromFileTimeUtc(creationFileTime)).ToString("o");
                BoundProcessLaunch launch = new BoundProcessLaunch(
                    process.ProcessId, process.Process, process.Thread,
                    startedAtUtc, executablePath);
                handedOff = true;
                return launch;
            }
            finally {
                if (created && !handedOff) {
                    TerminateProcess(process.Process, 1);
                    WaitForSingleObject(process.Process, 10000);
                    if (process.Thread != IntPtr.Zero) CloseHandle(process.Thread);
                    if (process.Process != IntPtr.Zero) CloseHandle(process.Process);
                }
                if (attributeList != IntPtr.Zero) {
                    DeleteProcThreadAttributeList(attributeList);
                    Marshal.FreeHGlobal(attributeList);
                }
                if (handleList != IntPtr.Zero) Marshal.FreeHGlobal(handleList);
                if (jobList != IntPtr.Zero) Marshal.FreeHGlobal(jobList);
                if (stdin != IntPtr.Zero && stdin != InvalidHandle) CloseHandle(stdin);
                if (stdout != IntPtr.Zero && stdout != InvalidHandle) CloseHandle(stdout);
                if (stderr != IntPtr.Zero && stderr != InvalidHandle) CloseHandle(stderr);
            }
        }
    }
}
'@
}

function New-DiagnosticPrepKillOnCloseJob {
    $handle = [SchoolPilot.DiagnosticPrep.JobNative]::CreateJobObject([IntPtr]::Zero, $null)
    if ($handle -eq [IntPtr]::Zero) {
        throw [ComponentModel.Win32Exception]::new(
            [Runtime.InteropServices.Marshal]::GetLastWin32Error(),
            "Unable to create the diagnostic preparation worker Job Object."
        )
    }
    try {
        $extended = [SchoolPilot.DiagnosticPrep.JobNative+ExtendedLimitInformation]::new()
        $basic = $extended.BasicLimitInformation
        $basic.LimitFlags = 0x00002000 # JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE
        $extended.BasicLimitInformation = $basic
        $size = [Runtime.InteropServices.Marshal]::SizeOf($extended)
        $buffer = [Runtime.InteropServices.Marshal]::AllocHGlobal($size)
        try {
            [Runtime.InteropServices.Marshal]::StructureToPtr($extended, $buffer, $false)
            if (-not [SchoolPilot.DiagnosticPrep.JobNative]::SetInformationJobObject(
                    $handle, 9, $buffer, [uint32]$size)) {
                throw [ComponentModel.Win32Exception]::new(
                    [Runtime.InteropServices.Marshal]::GetLastWin32Error(),
                    "Unable to arm kill-on-close worker ownership."
                )
            }
        }
        finally { [Runtime.InteropServices.Marshal]::FreeHGlobal($buffer) }
        return $handle
    }
    catch {
        [void][SchoolPilot.DiagnosticPrep.JobNative]::CloseHandle($handle)
        throw
    }
}

function Assert-DiagnosticPrepProcessOutsideJob {
    param([Parameter(Mandatory = $true)][Diagnostics.Process]$Process)
    $inJob = $false
    if (-not [SchoolPilot.DiagnosticPrep.JobNative]::IsProcessInJob(
            $Process.Handle, [IntPtr]::Zero, [ref]$inJob)) {
        throw [ComponentModel.Win32Exception]::new(
            [Runtime.InteropServices.Marshal]::GetLastWin32Error(),
            "Unable to verify the durable supervisor host boundary."
        )
    }
    if ($inJob) {
        throw "The admitted supervisor inherited a caller-owned Windows Job Object."
    }
}

function Start-DiagnosticPrepOutOfBandProcess {
    param(
        [Parameter(Mandatory = $true)][string]$ExecutablePath,
        [Parameter(Mandatory = $true)][string[]]$Arguments
    )
    $commandLine = (Quote-ProcessArgument $ExecutablePath) + " " + ($Arguments -join " ")
    $created = Invoke-CimMethod -ClassName Win32_Process -MethodName Create -Arguments @{
        CommandLine = $commandLine
        CurrentDirectory = $script:RepositoryRoot
    }
    if ($null -eq $created -or [uint32]$created.ReturnValue -ne 0 -or [uint32]$created.ProcessId -eq 0) {
        throw "The durable Windows process broker rejected the supervisor launch."
    }
    $brokeredPid = [int]$created.ProcessId
    $watch = [Diagnostics.Stopwatch]::StartNew()
    $process = $null
    $verified = $false
    try {
        do {
            try {
                $process = [Diagnostics.Process]::GetProcessById($brokeredPid)
                $process.Refresh()
                Assert-DiagnosticPrepProcessOutsideJob $process
                $verified = $true
                return $process
            }
            catch [ArgumentException] {
                if ($null -ne $process) { $process.Dispose(); $process = $null }
                if ($watch.Elapsed.TotalSeconds -ge 5) { throw }
                Start-Sleep -Milliseconds 25
            }
        } while ($true)
    }
    finally {
        if (-not $verified) {
            if ($null -ne $process) {
                try {
                    if (-not $process.HasExited) {
                        $process.Kill($true)
                        [void]$process.WaitForExit(10000)
                    }
                }
                finally { $process.Dispose() }
            }
        }
    }
}

function Start-DiagnosticPrepSuspendedJobProcess {
    param(
        [Parameter(Mandatory = $true)][string]$ExecutablePath,
        [Parameter(Mandatory = $true)][string[]]$Arguments,
        [Parameter(Mandatory = $true)][string]$StandardOutputPath,
        [Parameter(Mandatory = $true)][string]$StandardErrorPath,
        [Parameter(Mandatory = $true)][IntPtr]$JobHandle
    )
    $commandLine = (Quote-ProcessArgument $ExecutablePath) + " " + ($Arguments -join " ")
    $nativeLaunch = $null
    $process = $null
    try {
        # STARTUPINFOEX assigns both the exact stdio handles and the existing
        # kill-on-close Job Object as atomic CreateProcess attributes.  The
        # child remains suspended until ownership/state evidence is durable.
        $nativeLaunch = [SchoolPilot.DiagnosticPrep.JobNative]::CreateSuspendedProcessInJob(
            $ExecutablePath, $commandLine, $script:RepositoryRoot,
            $StandardOutputPath, $StandardErrorPath, $JobHandle
        )
        $process = [Diagnostics.Process]::GetProcessById([int]$nativeLaunch.ProcessId)
        # A newly suspended PowerShell process has not initialized enough for
        # Process.MainModule/Path on every Windows host.  Creation time comes
        # from GetProcessTimes on the native process handle; image identity is
        # the exact lpApplicationName passed to CreateProcessW.
        $identity = [ordered]@{
            pid = [int]$nativeLaunch.ProcessId
            startedAtUtc = [string]$nativeLaunch.StartedAtUtc
            path = [IO.Path]::GetFullPath([string]$nativeLaunch.ImagePath)
        }
        $inBoundJob = $false
        if (-not [SchoolPilot.DiagnosticPrep.JobNative]::IsProcessInJob(
                $process.Handle, $JobHandle, [ref]$inBoundJob) -or -not $inBoundJob) {
            throw "The suspended preparation worker Job binding could not be independently verified."
        }
        return [pscustomobject]@{
            Process = $process
            Identity = $identity
            NativeLaunch = $nativeLaunch
            Resumed = $false
        }
    }
    catch {
        if ($null -ne $nativeLaunch) { $nativeLaunch.Dispose() }
        if ($null -ne $process) { $process.Dispose() }
        throw
    }
}

function Resume-DiagnosticPrepJobProcess {
    param([Parameter(Mandatory = $true)]$BoundLaunch)
    if ($BoundLaunch.Resumed -eq $true) {
        throw "The Job-bound preparation worker was already resumed."
    }
    $BoundLaunch.NativeLaunch.Resume()
    $BoundLaunch.Resumed = $true
    $BoundLaunch.NativeLaunch.Dispose()
    $BoundLaunch.Process.Refresh()
}

function Close-DiagnosticPrepJob {
    param([IntPtr]$JobHandle)
    if ($JobHandle -ne [IntPtr]::Zero) {
        [void][SchoolPilot.DiagnosticPrep.JobNative]::CloseHandle($JobHandle)
    }
}

function Get-Value {
    param($Object, [string]$Name, $Default = $null)
    if ($null -eq $Object) { return $Default }
    if ($Object -is [Collections.IDictionary]) {
        if ($Object.Contains($Name)) { return $Object[$Name] }
        return $Default
    }
    $property = $Object.PSObject.Properties[$Name]
    if ($null -eq $property -or $null -eq $property.Value) { return $Default }
    return $property.Value
}

function Get-RequiredValue {
    param($Object, [string]$Name)
    $value = Get-Value $Object $Name $null
    if ($null -eq $value -or ($value -is [string] -and [string]::IsNullOrWhiteSpace($value))) {
        throw "A required preparation value is missing."
    }
    return $value
}

function Get-OfflineTestDelayMilliseconds {
    param(
        $ManifestInfo,
        [Parameter(Mandatory = $true)][string]$Name,
        [int]$Maximum = 30000
    )
    $controls = Get-Value $ManifestInfo.Value "testControls" $null
    if ($null -eq $controls) { return 0 }
    if ($controls -is [Array] -or $controls -is [ValueType] -or $controls -is [string]) {
        throw "Preparation test controls must be an object."
    }
    $contains = if ($controls -is [Collections.IDictionary]) { $controls.Contains($Name) }
        else { $null -ne $controls.PSObject.Properties[$Name] }
    if (-not $contains) { return 0 }
    $fixture = Get-RequiredValue $ManifestInfo.Value "fixture"
    if ((Get-Value $ManifestInfo.Value "diagnosticEligible" $true) -ne $false -or
        [string](Get-Value $fixture "provider" "") -cne "offline-fake") {
        throw "Supervisor delay controls are restricted to diagnostic-ineligible offline rehearsal."
    }
    $raw = Get-RequiredValue $controls $Name
    if ($raw -isnot [ValueType] -or [string]$raw -cnotmatch '^\d{1,5}$') {
        throw "An offline supervisor delay control is malformed."
    }
    $value = [int]$raw
    if ($value -lt 0 -or $value -gt $Maximum) {
        throw "An offline supervisor delay control is outside its bounded range."
    }
    return $value
}

function Get-TextSha256 {
    param([AllowEmptyString()][string]$Value)
    return [Convert]::ToHexString([Security.Cryptography.SHA256]::HashData(
        [Text.UTF8Encoding]::new($false).GetBytes($Value)
    )).ToLowerInvariant()
}

function Get-FileSha256 {
    param([string]$Path)
    return (Get-FileHash -LiteralPath $Path -Algorithm SHA256).Hash.ToLowerInvariant()
}

function Assert-Sha256 {
    param([string]$Value, [string]$Name)
    $normalized = ([string]$Value).ToLowerInvariant()
    if ($normalized -notmatch '^[0-9a-f]{64}$') { throw "$Name must be an exact SHA-256 digest." }
    return $normalized
}

function Test-IsInsideDirectory {
    param([string]$Path, [string]$Directory)
    $comparison = if ($IsWindows) { [StringComparison]::OrdinalIgnoreCase } else { [StringComparison]::Ordinal }
    $root = [IO.Path]::GetFullPath($Directory).TrimEnd('\', '/')
    $candidate = [IO.Path]::GetFullPath($Path).TrimEnd('\', '/')
    return [string]::Equals($candidate, $root, $comparison) -or
        $candidate.StartsWith($root + [IO.Path]::DirectorySeparatorChar, $comparison)
}

function Test-PreparationPathsOverlap {
    param([string]$Left, [string]$Right)
    $comparison = if ($IsWindows) { [StringComparison]::OrdinalIgnoreCase }
        else { [StringComparison]::Ordinal }
    $leftPath = [IO.Path]::GetFullPath($Left).TrimEnd('\', '/')
    $rightPath = [IO.Path]::GetFullPath($Right).TrimEnd('\', '/')
    $separator = [IO.Path]::DirectorySeparatorChar
    return [string]::Equals($leftPath, $rightPath, $comparison) -or
        $leftPath.StartsWith($rightPath + $separator, $comparison) -or
        $rightPath.StartsWith($leftPath + $separator, $comparison)
}

function Assert-PreparationExactKeys {
    param($Value, [string[]]$Required, [string]$Name)
    if ($null -eq $Value -or $Value -is [Array]) { throw "$Name must be an object." }
    $actual = if ($Value -is [Collections.IDictionary]) { @($Value.Keys | ForEach-Object { [string]$_ }) }
        else { @($Value.PSObject.Properties.Name) }
    if (@(Compare-Object ($Required | Sort-Object) ($actual | Sort-Object)).Count -ne 0) {
        throw "$Name fields are invalid."
    }
}

function Resolve-PreparationPathTopology {
    param($Manifest, [string]$RunId)
    $fixture = Get-RequiredValue $Manifest "fixture"
    $paths = Get-RequiredValue $Manifest "paths"
    $requiredPathFields = @(
        "runDirectoryRoot", "snapshotRoot", "journalPath", "fixturePreparationReceiptPath",
        "publicationRecoveryReceiptPath", "supervisorStatePath", "leaseReceiptPath",
        "bindingRoot", "evidenceDirectory", "startGatePath", "trafficMarkerPath"
    )
    Assert-PreparationExactKeys $paths $requiredPathFields "manifest.paths"
    $resolved = [ordered]@{}
    foreach ($field in $requiredPathFields) {
        $kind = if ($field -in @("runDirectoryRoot", "snapshotRoot", "bindingRoot", "evidenceDirectory")) {
            "Directory"
        } else { "File" }
        $resolved[$field] = Resolve-ExternalPath ([string](Get-RequiredValue $paths $field)) `
            "paths.$field" $kind -AllowMissing
    }
    $sourceRoot = Resolve-ExternalPath ([string](Get-RequiredValue $fixture "sourceRoot")) `
        "fixture.sourceRoot" Directory -AllowMissing
    if ([IO.Path]::GetFileName([string]$resolved.snapshotRoot) -cne $RunId) {
        throw "The immutable snapshot root must end in the exact run ID."
    }
    $rootEntries = @(
        [pscustomobject]@{ name = "fixture.sourceRoot"; path = $sourceRoot },
        [pscustomobject]@{ name = "paths.snapshotRoot"; path = [string]$resolved.snapshotRoot },
        [pscustomobject]@{ name = "paths.runDirectoryRoot"; path = [string]$resolved.runDirectoryRoot },
        [pscustomobject]@{ name = "paths.bindingRoot"; path = [string]$resolved.bindingRoot },
        [pscustomobject]@{ name = "paths.evidenceDirectory"; path = [string]$resolved.evidenceDirectory }
    )
    for ($left = 0; $left -lt $rootEntries.Count; $left++) {
        for ($right = $left + 1; $right -lt $rootEntries.Count; $right++) {
            if (Test-PreparationPathsOverlap $rootEntries[$left].path $rootEntries[$right].path) {
                throw "$($rootEntries[$left].name) and $($rootEntries[$right].name) must be distinct and non-nested."
            }
        }
    }
    $runControls = @(
        "journalPath", "fixturePreparationReceiptPath", "publicationRecoveryReceiptPath",
        "supervisorStatePath"
    )
    foreach ($field in $runControls) {
        $candidate = [string]$resolved[$field]
        if (-not (Test-IsInsideDirectory $candidate ([string]$resolved.runDirectoryRoot)) -or
            [string]::Equals($candidate, [string]$resolved.runDirectoryRoot,
                [StringComparison]::OrdinalIgnoreCase)) {
            throw "paths.$field must be a file inside paths.runDirectoryRoot."
        }
        foreach ($protected in $rootEntries | Where-Object { $_.name -ne "paths.runDirectoryRoot" }) {
            if (Test-PreparationPathsOverlap $candidate $protected.path) {
                throw "paths.$field must not overlap $($protected.name)."
            }
        }
    }
    if (@($runControls | ForEach-Object { [string]$resolved[$_] } | Sort-Object -Unique).Count -ne
        $runControls.Count) {
        throw "Preparation run control paths must be distinct."
    }
    foreach ($field in @("leaseReceiptPath", "startGatePath", "trafficMarkerPath")) {
        foreach ($root in $rootEntries) {
            if (Test-PreparationPathsOverlap ([string]$resolved[$field]) $root.path) {
                throw "paths.$field must not overlap $($root.name)."
            }
        }
    }
    return [pscustomobject]@{
        SourceRoot = $sourceRoot
        Paths = $resolved
    }
}

function Resolve-ExternalPath {
    param(
        [string]$Path,
        [string]$Name,
        [ValidateSet("Any", "File", "Directory")][string]$Kind = "Any",
        [switch]$AllowMissing
    )
    if ([string]::IsNullOrWhiteSpace($Path) -or -not [IO.Path]::IsPathRooted($Path)) {
        throw "$Name must be an absolute external path."
    }
    $resolved = [IO.Path]::GetFullPath($Path)
    if (Test-IsInsideDirectory $resolved $script:RepositoryRoot) {
        throw "$Name must be outside the repository."
    }
    $cursor = $resolved
    while (-not [string]::IsNullOrWhiteSpace($cursor)) {
        if (Test-Path -LiteralPath $cursor) {
            $item = Get-Item -LiteralPath $cursor -Force
            if (($item.Attributes -band [IO.FileAttributes]::ReparsePoint) -ne 0) {
                throw "$Name must not traverse a reparse point."
            }
        }
        $parent = [IO.Directory]::GetParent($cursor)
        if ($null -eq $parent) { break }
        $cursor = $parent.FullName
    }
    if (-not $AllowMissing) {
        if (-not (Test-Path -LiteralPath $resolved)) { throw "$Name does not exist." }
        if ($Kind -eq "File" -and -not (Test-Path -LiteralPath $resolved -PathType Leaf)) {
            throw "$Name must be a file."
        }
        if ($Kind -eq "Directory" -and -not (Test-Path -LiteralPath $resolved -PathType Container)) {
            throw "$Name must be a directory."
        }
    }
    return $resolved
}

function Set-PrivateAcl {
    param([string]$Path)
    if (-not $IsWindows) { throw "Diagnostic preparation requires Windows ACL enforcement." }
    $item = Get-Item -LiteralPath $Path -Force
    $isDirectory = $item.PSIsContainer
    $current = [Security.Principal.WindowsIdentity]::GetCurrent()
    $security = [IO.FileSystemAclExtensions]::GetAccessControl(
        $item, ([Security.AccessControl.AccessControlSections]::Access -bor
            [Security.AccessControl.AccessControlSections]::Owner)
    )
    # Elevated Windows hosts can assign newly created files/directories to the
    # BUILTIN\Administrators group even though the creating operator is the
    # only principal admitted by the protected DACL.  Make ownership explicit
    # before validating the exact current-operator-only ACL contract.
    $security.SetOwner($current.User)
    $security.SetAccessRuleProtection($true, $false)
    foreach ($existing in @($security.GetAccessRules(
                $true, $true, [Security.Principal.SecurityIdentifier]
            ))) {
        [void]$security.RemoveAccessRuleSpecific($existing)
    }
    $inheritance = if ($isDirectory) {
        [Security.AccessControl.InheritanceFlags]::ContainerInherit -bor
            [Security.AccessControl.InheritanceFlags]::ObjectInherit
    }
    else { [Security.AccessControl.InheritanceFlags]::None }
    $security.AddAccessRule([Security.AccessControl.FileSystemAccessRule]::new(
        $current.User,
        [Security.AccessControl.FileSystemRights]::FullControl,
        $inheritance,
        [Security.AccessControl.PropagationFlags]::None,
        [Security.AccessControl.AccessControlType]::Allow
    ))
    [IO.FileSystemAclExtensions]::SetAccessControl($item, $security)
    Assert-PrivateAcl $Path "private preparation artifact"
}

function Assert-PrivateAcl {
    param([string]$Path, [string]$Name)
    if (-not $IsWindows) { throw "$Name requires Windows ACL enforcement." }
    $absolute = [IO.Path]::GetFullPath($Path)
    $cursor = $absolute
    while (-not [string]::IsNullOrWhiteSpace($cursor)) {
        if (Test-Path -LiteralPath $cursor) {
            $candidate = Get-Item -LiteralPath $cursor -Force
            if (($candidate.Attributes -band [IO.FileAttributes]::ReparsePoint) -ne 0) {
                throw "$Name must not traverse a reparse point."
            }
        }
        $parent = [IO.Directory]::GetParent($cursor)
        if ($null -eq $parent) { break }
        $cursor = $parent.FullName
    }
    $item = Get-Item -LiteralPath $absolute -Force
    $isDirectory = $item.PSIsContainer
    $currentSid = [Security.Principal.WindowsIdentity]::GetCurrent().User.Value
    $security = [IO.FileSystemAclExtensions]::GetAccessControl(
        $item, ([Security.AccessControl.AccessControlSections]::Access -bor
            [Security.AccessControl.AccessControlSections]::Owner)
    )
    $ownerSid = $security.GetOwner([Security.Principal.SecurityIdentifier]).Value
    if ($ownerSid -cne $currentSid) {
        throw "$Name must be owned by the current operator."
    }
    if (-not $security.AreAccessRulesProtected) { throw "$Name must disable inherited access." }
    $rules = @($security.GetAccessRules($true, $true, [Security.Principal.SecurityIdentifier]))
    $expectedInheritance = if ($isDirectory) {
        [Security.AccessControl.InheritanceFlags]::ContainerInherit -bor
            [Security.AccessControl.InheritanceFlags]::ObjectInherit
    }
    else { [Security.AccessControl.InheritanceFlags]::None }
    if ($rules.Count -ne 1) { throw "$Name must have one current-operator access rule." }
    $rule = $rules[0]
    if ($rule.IsInherited -or
        $rule.AccessControlType -ne [Security.AccessControl.AccessControlType]::Allow -or
        $rule.IdentityReference.Value -cne $currentSid -or
        $rule.FileSystemRights -ne [Security.AccessControl.FileSystemRights]::FullControl -or
        $rule.InheritanceFlags -ne $expectedInheritance -or
        $rule.PropagationFlags -ne [Security.AccessControl.PropagationFlags]::None) {
        throw "$Name must have one exact current-operator FullControl rule."
    }
}

function New-PrivateDirectory {
    param([string]$Path)
    if (-not (Test-Path -LiteralPath $Path)) {
        [void][IO.Directory]::CreateDirectory($Path)
    }
    if (-not (Test-Path -LiteralPath $Path -PathType Container)) {
        throw "The preparation run root must be a directory."
    }
    Set-PrivateAcl $Path
}

function New-PrivateEmptyFile {
    param([string]$Path)
    if (Test-Path -LiteralPath $Path) { throw "A fresh preparation control file is required." }
    $stream = [IO.FileStream]::new(
        $Path, [IO.FileMode]::CreateNew, [IO.FileAccess]::Write, [IO.FileShare]::None,
        4096, [IO.FileOptions]::WriteThrough
    )
    try { $stream.Flush($true) }
    finally { $stream.Dispose() }
    Set-PrivateAcl $Path
}

function Publish-PrivateFileAtomicWithRetry {
    param([string]$Source, [string]$Destination, [switch]$Immutable)
    for ($attempt = 0; $attempt -le 40; $attempt++) {
        try {
            if ($Immutable -and [IO.File]::Exists($Destination)) {
                throw "An immutable preparation artifact already exists."
            }
            # Let the filesystem operation itself enforce immutable creation.
            # An existence precheck alone would permit a competing creator to
            # be overwritten between the check and rename.
            [IO.File]::Move($Source, $Destination, -not $Immutable)
            return
        }
        catch {
            $cursor = $_.Exception
            $fileSystemException = $null
            while ($null -ne $cursor) {
                if ($cursor -is [IO.IOException] -or $cursor -is [UnauthorizedAccessException]) {
                    $fileSystemException = $cursor
                    break
                }
                $cursor = $cursor.InnerException
            }
            $nativeCode = if ($null -eq $fileSystemException) { -1 } else { $fileSystemException.HResult -band 0xffff }
            if ($nativeCode -notin @(5, 32, 33) -or $attempt -eq 40) { throw }
            Start-Sleep -Milliseconds 25
        }
    }
    throw "Atomic private-file publication exhausted its bounded retry window."
}

function Write-PrivateJson {
    param([string]$Path, $Value, [switch]$Immutable)
    if ($Immutable -and (Test-Path -LiteralPath $Path)) {
        throw "An immutable preparation artifact already exists."
    }
    $parent = [IO.Path]::GetDirectoryName([IO.Path]::GetFullPath($Path))
    if (-not (Test-Path -LiteralPath $parent -PathType Container)) {
        throw "The preparation artifact parent directory is missing."
    }
    Assert-PrivateAcl $parent "preparation artifact parent"
    $temporary = Join-Path $parent ".$([IO.Path]::GetFileName($Path)).$([Guid]::NewGuid().ToString('N')).tmp"
    $bytes = Get-PrivateJsonBytes $Value
    try {
        $stream = [IO.FileStream]::new(
            $temporary, [IO.FileMode]::CreateNew, [IO.FileAccess]::Write,
            [IO.FileShare]::None, 4096, [IO.FileOptions]::WriteThrough
        )
        try {
            $stream.Write($bytes, 0, $bytes.Length)
            $stream.Flush($true)
        }
        finally { $stream.Dispose() }
        Set-PrivateAcl $temporary
        if ([IO.File]::Exists($Path)) {
            if ($Immutable) { throw "An immutable preparation artifact already exists." }
            # With an exact current-operator FullControl descriptor already
            # proven, Win32 access-denied from atomic overwrite is a sharing
            # race rather than an ACL authorization failure.
            Assert-PrivateAcl $Path "mutable private preparation JSON"
        }
        Publish-PrivateFileAtomicWithRetry $temporary $Path -Immutable:$Immutable
        Assert-PrivateAcl $Path "private preparation JSON"
    }
    finally {
        if ([IO.File]::Exists($temporary)) { [IO.File]::Delete($temporary) }
    }
}

function Get-PrivateJsonBytes {
    param($Value)
    return [Text.UTF8Encoding]::new($false).GetBytes(($Value | ConvertTo-Json -Depth 60))
}

function Get-BytesSha256 {
    param([byte[]]$Bytes)
    return [Convert]::ToHexString([Security.Cryptography.SHA256]::HashData($Bytes)).ToLowerInvariant()
}

function Write-PrivateBytes {
    param([string]$Path, [byte[]]$Bytes, [switch]$Immutable)
    if ($Immutable -and (Test-Path -LiteralPath $Path)) {
        throw "An immutable preparation artifact already exists."
    }
    $parent = [IO.Path]::GetDirectoryName([IO.Path]::GetFullPath($Path))
    if (-not (Test-Path -LiteralPath $parent -PathType Container)) {
        throw "The preparation artifact parent directory is missing."
    }
    Assert-PrivateAcl $parent "preparation artifact parent"
    $temporary = Join-Path $parent ".$([IO.Path]::GetFileName($Path)).$([Guid]::NewGuid().ToString('N')).tmp"
    try {
        $stream = [IO.FileStream]::new(
            $temporary, [IO.FileMode]::CreateNew, [IO.FileAccess]::Write,
            [IO.FileShare]::None, 4096, [IO.FileOptions]::WriteThrough
        )
        try { $stream.Write($Bytes, 0, $Bytes.Length); $stream.Flush($true) }
        finally { $stream.Dispose() }
        Set-PrivateAcl $temporary
        Publish-PrivateFileAtomicWithRetry $temporary $Path -Immutable:$Immutable
    }
    finally { if (Test-Path -LiteralPath $temporary) { Remove-Item -LiteralPath $temporary -Force } }
}

function Read-PrivateTextShared {
    param([string]$Path)
    $stream = [IO.FileStream]::new(
        $Path, [IO.FileMode]::Open, [IO.FileAccess]::Read,
        ([IO.FileShare]::ReadWrite -bor [IO.FileShare]::Delete)
    )
    try {
        $reader = [IO.StreamReader]::new($stream, [Text.UTF8Encoding]::new($false), $true, 4096, $true)
        try { return $reader.ReadToEnd() }
        finally { $reader.Dispose() }
    }
    finally { $stream.Dispose() }
}

function Read-PrivateJson {
    param([string]$Path, [int]$Depth = 60)
    Assert-PrivateAcl $Path "private preparation JSON"
    try {
        return Read-PrivateTextShared $Path | ConvertFrom-Json -DateKind String -Depth $Depth -ErrorAction Stop
    }
    catch { throw "A private preparation JSON artifact is malformed." }
}

function ConvertTo-UtcString {
    param([datetime]$Value)
    return ([DateTimeOffset]$Value).ToUniversalTime().ToString("o")
}

function Get-ProcessIdentity {
    param([Diagnostics.Process]$Process)
    try {
        return [ordered]@{
            pid = $Process.Id
            startedAtUtc = ConvertTo-UtcString $Process.StartTime
            path = [IO.Path]::GetFullPath($Process.Path)
        }
    }
    catch { throw "A bound process identity could not be captured." }
}

function Test-BoundProcessPresent {
    param($Identity)
    if ($null -eq $Identity) { return $false }
    $pidValue = [int](Get-Value $Identity "pid" 0)
    if ($pidValue -le 0) { return $false }
    try { $process = [Diagnostics.Process]::GetProcessById($pidValue) }
    catch [ArgumentException] { return $false }
    catch { throw "The bound process could not be inspected safely." }
    try {
        $actualStarted = ConvertTo-UtcString $process.StartTime
        $actualPath = [IO.Path]::GetFullPath($process.Path)
        $expectedStarted = [string](Get-RequiredValue $Identity "startedAtUtc")
        $expectedPath = [IO.Path]::GetFullPath([string](Get-RequiredValue $Identity "path"))
        return $actualStarted -ceq $expectedStarted -and
            [string]::Equals($actualPath, $expectedPath, [StringComparison]::OrdinalIgnoreCase)
    }
    catch { throw "The bound process identity could not be inspected safely." }
    finally { $process.Dispose() }
}

function Stop-BoundProcess {
    param(
        [Diagnostics.Process]$Process,
        [ValidateRange(1000, 30000)][int]$TimeoutMilliseconds = 10000
    )
    if ($null -eq $Process) { return }
    $identity = $null
    try {
        if ($Process.HasExited) {
            if (-not $Process.WaitForExit($TimeoutMilliseconds)) {
                throw "The bound process exit could not be observed within the bounded grace period."
            }
            return
        }
        $identity = Get-ProcessIdentity $Process
        if (-not (Test-BoundProcessPresent $identity)) { return }
        # Diagnostics.Process owns a handle to this exact process object, so
        # Kill(entireProcessTree) cannot target a later PID reuse.  The
        # identity-gated taskkill path is fallback only.
        $Process.Kill($true)
    }
    catch {
        try {
            if (-not $Process.HasExited -and $null -ne $identity -and
                (Test-BoundProcessPresent $identity)) {
                & taskkill.exe /PID ([string]$Process.Id) /T /F 2>$null | Out-Null
                if ($LASTEXITCODE -notin @(0, 128)) {
                    throw "The exact bound process tree rejected fallback termination."
                }
            }
        }
        catch {
            throw "The bound process tree could not be terminated."
        }
    }
    if (-not $Process.WaitForExit($TimeoutMilliseconds)) {
        throw "The bound process tree did not terminate within the bounded grace period."
    }
    if ($null -ne $identity -and (Test-BoundProcessPresent $identity)) {
        throw "The exact bound process identity remained present after termination."
    }
}

function Get-ControllerArtifact {
    param($Manifest, [string]$Kind)
    $matches = @(@(Get-RequiredValue $Manifest "controllerArtifacts") | Where-Object {
            [string](Get-Value $_ "kind" "") -ceq $Kind
        })
    if ($matches.Count -ne 1) { throw "The preparation manifest must bind one exact controller artifact." }
    $binding = $matches[0]
    $rawPath = [string](Get-RequiredValue $binding "path")
    $path = if ([IO.Path]::IsPathRooted($rawPath)) {
        [IO.Path]::GetFullPath($rawPath)
    }
    else { [IO.Path]::GetFullPath((Join-Path $script:RepositoryRoot $rawPath)) }
    if (-not (Test-IsInsideDirectory $path $script:RepositoryRoot) -or
        [string]::Equals($path, $script:RepositoryRoot, [StringComparison]::OrdinalIgnoreCase) -or
        -not (Test-Path -LiteralPath $path -PathType Leaf)) {
        throw "A controller artifact must resolve to a tracked file inside the repository."
    }
    $sha = Assert-Sha256 ([string](Get-RequiredValue $binding "sha256")) "$Kind sha256"
    return [pscustomobject]@{ path = $path; sha256 = $sha }
}

function Read-PreparationManifest {
    param([string]$Path, [string]$ExpectedSha256)
    $resolved = Resolve-ExternalPath $Path "ManifestPath" File
    Assert-PrivateAcl $resolved "preparation manifest"
    $expected = Assert-Sha256 $ExpectedSha256 "ExpectedManifestSha256"
    $actual = Get-FileSha256 $resolved
    if ($actual -cne $expected) { throw "The preparation manifest hash does not match." }
    $manifest = Read-PrivateJson $resolved
    if ([int](Get-Value $manifest "schemaVersion" 0) -ne 1 -or
        [string](Get-Value $manifest "type" "") -cne $script:ManifestType -or
        [string](Get-Value $manifest "version" "") -cne $script:ManifestVersion -or
        (Get-Value $manifest "diagnosticOnly" $false) -ne $true -or
        (Get-Value $manifest "certificationEligible" $true) -ne $false) {
        throw "The preparation manifest has an unsupported identity or eligibility contract."
    }
    $runId = [string](Get-RequiredValue $manifest "runId")
    if ($runId -notmatch '^[A-Za-z0-9][A-Za-z0-9._-]{0,199}$') { throw "The preparation run ID is malformed." }
    $manifestRepository = [IO.Path]::GetFullPath([string](Get-RequiredValue $manifest "repositoryRoot"))
    if (-not [string]::Equals($manifestRepository, $script:RepositoryRoot, [StringComparison]::OrdinalIgnoreCase)) {
        throw "The preparation manifest is bound to a different repository."
    }
    # This shallow topology proof happens before Start creates or ACL-mutates
    # the run directory.  The worker repeats the complete contract later.
    $topology = Resolve-PreparationPathTopology $manifest $runId
    $runRoot = [string]$topology.Paths.runDirectoryRoot
    $statePath = [string]$topology.Paths.supervisorStatePath
    $workerBinding = Get-ControllerArtifact $manifest "fixture-worker"
    if (-not [string]::Equals($workerBinding.path, $script:WorkerPath, [StringComparison]::OrdinalIgnoreCase) -or
        -not (Test-Path -LiteralPath $script:WorkerPath -PathType Leaf) -or
        (Get-FileSha256 $script:WorkerPath) -cne $workerBinding.sha256) {
        throw "The manifest fixture-worker binding does not match the repository worker."
    }
    $selfMatches = @(@(Get-RequiredValue $manifest "controllerArtifacts") | Where-Object {
            [string](Get-Value $_ "kind" "") -ceq "prep-supervisor"
        })
    if ($selfMatches.Count -ne 1) {
        throw "The preparation manifest must bind exactly one prep-supervisor artifact."
    }
    if ($selfMatches.Count -eq 1) {
        $selfBinding = $selfMatches[0]
        $selfRawPath = [string](Get-RequiredValue $selfBinding "path")
        $selfBoundPath = if ([IO.Path]::IsPathRooted($selfRawPath)) {
            [IO.Path]::GetFullPath($selfRawPath)
        }
        else { [IO.Path]::GetFullPath((Join-Path $script:RepositoryRoot $selfRawPath)) }
        if (-not [string]::Equals(
                $selfBoundPath,
                $script:SelfPath, [StringComparison]::OrdinalIgnoreCase
            ) -or (Get-FileSha256 $script:SelfPath) -cne
            (Assert-Sha256 ([string](Get-RequiredValue $selfBinding "sha256")) "prep-supervisor sha256")) {
            throw "The manifest preparation-supervisor binding changed."
        }
    }
    if ($SupervisorTimeoutSeconds -ne $script:DefaultTimeoutSeconds -and
        (Get-Value $manifest "diagnosticEligible" $true) -ne $false) {
        throw "Production-eligible preparation must retain the 35-minute supervisor timeout."
    }
    return [pscustomobject]@{
        Value = $manifest
        Path = $resolved
        Sha256 = $actual
        RunId = $runId
        RunRoot = $runRoot
        StatePath = $statePath
        Worker = $workerBinding
        DiagnosticEligible = [bool](Get-Value $manifest "diagnosticEligible" $false)
        SourceRoot = [string]$topology.SourceRoot
        SnapshotRoot = [string]$topology.Paths.snapshotRoot
        BindingRoot = [string]$topology.Paths.bindingRoot
        EvidenceRoot = [string]$topology.Paths.evidenceDirectory
        Paths = $topology.Paths
    }
}

function Get-ControlPaths {
    param($ManifestInfo, [string]$RequestedTicketPath)
    $runRoot = $ManifestInfo.RunRoot
    $ticket = if ([string]::IsNullOrWhiteSpace($RequestedTicketPath)) {
        Join-Path $runRoot "supervisor-ticket.private.json"
    }
    else { Resolve-ExternalPath $RequestedTicketPath "TicketPath" File -AllowMissing }
    if (-not (Test-IsInsideDirectory $ticket $runRoot) -or $ticket -eq $runRoot) {
        throw "TicketPath must be a file inside the preparation run directory."
    }
    $paths = Get-RequiredValue $ManifestInfo.Value "paths"
    $journalPath = Resolve-ExternalPath ([string](Get-RequiredValue $paths "journalPath")) "paths.journalPath" File -AllowMissing
    $receiptPath = Resolve-ExternalPath ([string](Get-RequiredValue $paths "fixturePreparationReceiptPath")) `
        "paths.fixturePreparationReceiptPath" File -AllowMissing
    foreach ($bound in @($ManifestInfo.StatePath, $journalPath, $receiptPath)) {
        if (-not (Test-IsInsideDirectory $bound $runRoot) -or $bound -eq $runRoot) {
            throw "Preparation control artifacts must be files inside the run directory."
        }
    }
    $publicationRecoveryReceiptPath = Resolve-ExternalPath `
        ([string](Get-RequiredValue $paths "publicationRecoveryReceiptPath")) `
        "paths.publicationRecoveryReceiptPath" File -AllowMissing
    $control = [pscustomobject]@{
        Ticket = $ticket
        LaunchAdmission = Join-Path $runRoot "supervisor-launch-admission.private.json"
        LaunchPresence = Join-Path $runRoot "supervisor-launch-presence.private.json"
        State = $ManifestInfo.StatePath
        Result = Join-Path $runRoot "supervisor-result.private.json"
        SupervisorStdout = Join-Path $runRoot "supervisor.stdout.log"
        SupervisorStderr = Join-Path $runRoot "supervisor.stderr.log"
        WorkerStdout = Join-Path $runRoot "fixture-worker.stdout.log"
        WorkerStderr = Join-Path $runRoot "fixture-worker.stderr.log"
        RecoveryStdout = Join-Path $runRoot "publication-recovery.stdout.log"
        RecoveryStderr = Join-Path $runRoot "publication-recovery.stderr.log"
        RecoveryResult = Join-Path $runRoot "publication-recovery-result.private.json"
        RecoveryAdmission = Join-Path $runRoot "publication-recovery-admission.private.json"
        OriginalState = Join-Path $runRoot "original-supervisor-state.private.json"
        SupervisorLock = Join-Path $runRoot "supervisor-run.private.lock"
        WorkerOwnership = Join-Path $runRoot "worker-ownership.private.json"
        RecoveryWorkerOwnership = Join-Path $runRoot "publication-recovery-worker-ownership.private.json"
        Journal = $journalPath
        Receipt = $receiptPath
        PublicationRecoveryReceipt = $publicationRecoveryReceiptPath
    }
    $allControlPaths = @($control.PSObject.Properties | ForEach-Object { [string]$_.Value })
    if (@($allControlPaths | Sort-Object -Unique).Count -ne $allControlPaths.Count) {
        throw "Every preparation supervisor control path must be distinct."
    }
    foreach ($bound in $allControlPaths) {
        if (-not (Test-IsInsideDirectory $bound $runRoot) -or
            [string]::Equals($bound, $runRoot, [StringComparison]::OrdinalIgnoreCase)) {
            throw "Every preparation supervisor control artifact must be inside the run directory."
        }
    }
    return $control
}

function Get-PreparationMutexName {
    param([string]$RunId)
    return "Local\SchoolPilot.Waf800DiagnosticPreparation.$((Get-TextSha256 $RunId).Substring(0, 32))"
}

function Get-SupervisorMutexName {
    param([string]$RunId)
    return "Local\SchoolPilot.Waf800DiagnosticPreparationSupervisor.$((Get-TextSha256 $RunId).Substring(0, 32))"
}

function Assert-NamedMutexFree {
    param([string]$Name, [string]$FailureMessage)
    $mutex = [Threading.Mutex]::new($false, $Name)
    $acquired = $false
    try {
        try { $acquired = $mutex.WaitOne(0) }
        catch [Threading.AbandonedMutexException] { $acquired = $true }
        if (-not $acquired) { throw $FailureMessage }
    }
    finally {
        if ($acquired) { $mutex.ReleaseMutex() }
        $mutex.Dispose()
    }
}

function Enter-NewOwnedMutex {
    param([string]$Name, [string]$FailureMessage)
    $created = $false
    $mutex = [Threading.Mutex]::new($true, $Name, [ref]$created)
    if (-not $created) {
        $mutex.Dispose()
        throw $FailureMessage
    }
    return $mutex
}

function Exit-OwnedMutex {
    param($Mutex)
    if ($null -eq $Mutex) { return }
    try { $Mutex.ReleaseMutex() }
    finally { $Mutex.Dispose() }
}

function Assert-PreparationMutexFree {
    param([string]$RunId)
    Assert-NamedMutexFree (Get-PreparationMutexName $RunId) `
        "The fixture preparation worker still owns the run mutex."
}

function New-RunLockRecord {
    param($ManifestInfo, $TicketInfo)
    return [ordered]@{
        schemaVersion = 1
        type = "diagnostic_prep_supervisor_run_lock"
        version = $script:RunLockVersion
        runId = $ManifestInfo.RunId
        manifest = [ordered]@{ path = $ManifestInfo.Path; sha256 = $ManifestInfo.Sha256 }
        ticket = [ordered]@{ path = $TicketInfo.path; sha256 = $TicketInfo.sha256 }
        supervisorMutexName = Get-SupervisorMutexName $ManifestInfo.RunId
        workerMutexName = Get-PreparationMutexName $ManifestInfo.RunId
    }
}

function Enter-ExclusiveRunFileLock {
    param($ManifestInfo, $TicketInfo, $Control, [switch]$Create)
    if ($Create) {
        if (Test-Path -LiteralPath $Control.SupervisorLock) {
            throw "A fresh persistent supervisor lock file is required."
        }
        Write-PrivateJson $Control.SupervisorLock (New-RunLockRecord $ManifestInfo $TicketInfo) -Immutable
    }
    elseif (-not (Test-Path -LiteralPath $Control.SupervisorLock -PathType Leaf)) {
        throw "The persistent supervisor lock file is missing."
    }
    Assert-PrivateAcl $Control.SupervisorLock "persistent supervisor run lock"
    $record = Read-PrivateJson $Control.SupervisorLock
    $expected = New-RunLockRecord $ManifestInfo $TicketInfo
    if (($record | ConvertTo-Json -Compress -Depth 20) -cne
        ($expected | ConvertTo-Json -Compress -Depth 20)) {
        throw "The persistent supervisor lock binding changed."
    }
    $lockSha256 = Get-FileSha256 $Control.SupervisorLock
    try {
        $stream = [IO.FileStream]::new(
            $Control.SupervisorLock,
            [IO.FileMode]::Open,
            [IO.FileAccess]::Read,
            [IO.FileShare]::None,
            4096,
            [IO.FileOptions]::WriteThrough
        )
        return [pscustomobject]@{
            path = $Control.SupervisorLock
            sha256 = $lockSha256
            stream = $stream
        }
    }
    catch {
        throw "Another session owns the persistent supervisor run lock."
    }
}

function Assert-ExclusiveRunFileLockFree {
    param($ManifestInfo, $TicketInfo, $Control)
    $lock = Enter-ExclusiveRunFileLock $ManifestInfo $TicketInfo $Control
    $lock.stream.Dispose()
}

function Set-SleepPrevention {
    param([bool]$Enabled)
    if (-not $IsWindows) { return }
    if (-not ("SchoolPilot.DiagnosticPreparationPowerState" -as [type])) {
        [void](Add-Type -TypeDefinition @"
using System;
using System.Runtime.InteropServices;
namespace SchoolPilot {
    public static class DiagnosticPreparationPowerState {
        [DllImport("kernel32.dll", SetLastError = true)]
        public static extern uint SetThreadExecutionState(uint flags);
    }
}
"@
        )
    }
    $flags = if ($Enabled) { [Convert]::ToUInt32("80000041", 16) }
    else { [Convert]::ToUInt32("80000000", 16) }
    if ([SchoolPilot.DiagnosticPreparationPowerState]::SetThreadExecutionState($flags) -eq 0) {
        throw "Windows rejected the preparation sleep-prevention request."
    }
}

function Quote-ProcessArgument {
    param([string]$Value)
    if ($Value.Contains('"')) { throw "Preparation process arguments must not contain quote characters." }
    return '"' + $Value + '"'
}

function Get-PwshPath {
    $command = Get-Command pwsh -ErrorAction Stop
    return [IO.Path]::GetFullPath($command.Source)
}

function Invoke-WorkerValidation {
    param($ManifestInfo)
    $startInfo = [Diagnostics.ProcessStartInfo]::new()
    $startInfo.FileName = Get-PwshPath
    $startInfo.UseShellExecute = $false
    $startInfo.CreateNoWindow = $true
    $startInfo.RedirectStandardOutput = $true
    $startInfo.RedirectStandardError = $true
    foreach ($argument in @(
            "-NoProfile", "-File", $ManifestInfo.Worker.path,
            "-Mode", "Validate", "-ManifestPath", $ManifestInfo.Path,
            "-ExpectedManifestSha256", $ManifestInfo.Sha256
        )) {
        [void]$startInfo.ArgumentList.Add([string]$argument)
    }
    $process = [Diagnostics.Process]::new()
    $process.StartInfo = $startInfo
    try {
        if (-not $process.Start()) { throw "The fixture-worker validation process did not start." }
        $stdoutTask = $process.StandardOutput.ReadToEndAsync()
        $stderrTask = $process.StandardError.ReadToEndAsync()
        if (-not $process.WaitForExit(120000)) {
            Stop-BoundProcess $process
            throw "The fixture-worker validation process timed out."
        }
        $process.WaitForExit()
        $stdout = $stdoutTask.GetAwaiter().GetResult()
        $stderr = $stderrTask.GetAwaiter().GetResult()
        if ($process.ExitCode -ne 0 -or -not [string]::IsNullOrWhiteSpace($stderr)) {
            throw "The fixture-worker validation gate rejected the preparation manifest."
        }
        try { $result = $stdout | ConvertFrom-Json -DateKind String -Depth 60 -ErrorAction Stop }
        catch { throw "The fixture-worker validation result is malformed." }
        if ($result -is [Array] -or (Get-Value $result "valid" $false) -ne $true -or
            [string](Get-Value $result "runId" "") -cne $ManifestInfo.RunId -or
            [string](Get-Value $result "manifestSha256" "") -cne $ManifestInfo.Sha256 -or
            (Get-Value $result "mutationStarted" $true) -ne $false) {
            throw "The fixture-worker validation result did not prove a read-only bound preflight."
        }
        return $result
    }
    finally { $process.Dispose() }
}

function Assert-NoPreparationDownstreamArtifacts {
    param($ManifestInfo)
    foreach ($field in @(
            "leaseReceiptPath", "bindingRoot", "evidenceDirectory",
            "startGatePath", "trafficMarkerPath"
        )) {
        $path = [string]$ManifestInfo.Paths[$field]
        if (Test-Path -LiteralPath $path) {
            throw "A downstream diagnostic artifact blocks fresh preparation admission."
        }
    }
}

function Read-JournalStatusOnce {
    param($ManifestInfo, $Control, [switch]$RequireTerminal)
    if (-not (Test-Path -LiteralPath $Control.Journal -PathType Leaf)) {
        if ($RequireTerminal) { throw "The preparation journal is missing its terminal commit." }
        return [pscustomobject]@{
            exists = $false; path = $Control.Journal; sha256 = $null
            recordCount = 0; lastStage = $null; lastRecordHash = $null
            lastStatus = $null; terminalCommitted = $false; hasPartialRecord = $false
        }
    }
    Assert-PrivateAcl $Control.Journal "preparation journal"
    $journalBytes = [IO.File]::ReadAllBytes($Control.Journal)
    $journalSha256 = [Convert]::ToHexString(
        [Security.Cryptography.SHA256]::HashData($journalBytes)
    ).ToLowerInvariant()
    $raw = [Text.UTF8Encoding]::new($false, $true).GetString($journalBytes)
    $hasPartial = $raw.Length -gt 0 -and -not ($raw.EndsWith("`n"))
    $segments = @($raw -split "`r?`n")
    if ($hasPartial -and $segments.Count -gt 0) {
        $segments = if ($segments.Count -eq 1) { @() } else { @($segments[0..($segments.Count - 2)]) }
    }
    $lines = @($segments | Where-Object { -not [string]::IsNullOrWhiteSpace($_) })
    $expectedSequence = 1
    $previous = $null
    $last = $null
    $expectedRecordKeys = @(
        "schemaVersion", "type", "version", "sequence", "runId", "manifestSha256",
        "timestampUtc", "stage", "status", "process", "exitCode", "artifactHashes",
        "previousRecordHash", "failureCode", "failureStage", "recordHash"
    )
    foreach ($line in $lines) {
        try { $record = $line | ConvertFrom-Json -DateKind String -Depth 40 -ErrorAction Stop }
        catch { throw "The preparation journal contains malformed committed JSON." }
        Assert-PreparationExactKeys $record $expectedRecordKeys "preparation journal record"
        $recordHash = Assert-Sha256 ([string](Get-RequiredValue $record "recordHash")) "journal recordHash"
        if ([int](Get-Value $record "sequence" 0) -ne $expectedSequence -or
            [string](Get-Value $record "type" "") -cne "diagnostic_prep_journal_record" -or
            [string](Get-Value $record "version" "") -cne $script:JournalVersion -or
            [string](Get-Value $record "runId" "") -cne $ManifestInfo.RunId -or
            [string](Get-Value $record "manifestSha256" "") -cne $ManifestInfo.Sha256) {
            throw "The preparation journal identity or sequence is invalid."
        }
        $recordPrevious = Get-Value $record "previousRecordHash" $null
        if (($expectedSequence -eq 1 -and $null -ne $recordPrevious) -or
            ($expectedSequence -gt 1 -and [string]$recordPrevious -cne $previous)) {
            throw "The preparation journal hash chain is broken."
        }
        $core = [ordered]@{
            schemaVersion = [int](Get-Value $record "schemaVersion" 0)
            type = [string](Get-Value $record "type" "")
            version = [string](Get-Value $record "version" "")
            sequence = [int](Get-Value $record "sequence" 0)
            runId = [string](Get-Value $record "runId" "")
            manifestSha256 = [string](Get-Value $record "manifestSha256" "")
            timestampUtc = [string](Get-RequiredValue $record "timestampUtc")
            stage = [string](Get-RequiredValue $record "stage")
            status = [string](Get-RequiredValue $record "status")
            process = Get-Value $record "process" $null
            exitCode = Get-Value $record "exitCode" $null
            artifactHashes = Get-Value $record "artifactHashes" $null
            previousRecordHash = $recordPrevious
            failureCode = Get-Value $record "failureCode" $null
            failureStage = Get-Value $record "failureStage" $null
        }
        $computed = Get-TextSha256 ($core | ConvertTo-Json -Compress -Depth 50)
        if ($computed -cne $recordHash) { throw "The preparation journal record hash is invalid." }
        $previous = $computed
        $last = $record
        $expectedSequence++
    }
    $terminal = $null -ne $last -and
        [string](Get-Value $last "stage" "") -ceq "terminal_commit" -and
        [string](Get-Value $last "status" "") -ceq "completed"
    if ($RequireTerminal -and ($hasPartial -or -not $terminal)) {
        throw "The preparation journal is not sealed by a complete terminal commit."
    }
    return [pscustomobject]@{
        exists = $true
        path = $Control.Journal
        sha256 = $journalSha256
        recordCount = $lines.Count
        lastStage = if ($null -eq $last) { $null } else { [string](Get-Value $last "stage" "") }
        lastStatus = if ($null -eq $last) { $null } else { [string](Get-Value $last "status" "") }
        lastRecordHash = $previous
        terminalCommitted = $terminal
        hasPartialRecord = $hasPartial
    }
}

function Read-JournalStatus {
    param($ManifestInfo, $Control, [switch]$RequireTerminal)
    $lastFailure = $null
    # A writer may be between its write-through JSON bytes and trailing newline,
    # or Windows may transiently deny metadata observation while the append
    # handle is open.  Read one coherent byte snapshot per attempt and retry for
    # a tightly bounded interval; permanent schema/hash/ACL failures still fail.
    for ($attempt = 1; $attempt -le 25; $attempt++) {
        try {
            return Read-JournalStatusOnce $ManifestInfo $Control -RequireTerminal:$RequireTerminal
        }
        catch {
            $lastFailure = $_
            if ($attempt -eq 25) { throw }
            Start-Sleep -Milliseconds 10
        }
    }
    throw $lastFailure
}

function Read-PreparationReceiptStatus {
    param($ManifestInfo, $Control, [switch]$Required)
    if (-not (Test-Path -LiteralPath $Control.Receipt -PathType Leaf)) {
        if ($Required) { throw "The fixture preparation receipt is missing." }
        return $null
    }
    $sha = Get-FileSha256 $Control.Receipt
    $receipt = Read-PrivateJson $Control.Receipt
    if ([int](Get-Value $receipt "schemaVersion" 0) -ne 1 -or
        [string](Get-Value $receipt "type" "") -cne "fixture_preparation_receipt" -or
        [string](Get-Value $receipt "version" "") -cne "fixture-preparation-receipt-v1" -or
        [string](Get-Value $receipt "runId" "") -cne $ManifestInfo.RunId -or
        [string](Get-Value $receipt "status" "") -cne "sources_sealed") {
        throw "The fixture preparation receipt identity is invalid."
    }
    $manifestReference = Get-RequiredValue $receipt "manifest"
    if ([string](Get-Value $manifestReference "path" "") -cne $ManifestInfo.Path -or
        [string](Get-Value $manifestReference "sha256" "") -cne $ManifestInfo.Sha256) {
        throw "The fixture preparation receipt is not bound to this manifest."
    }
    return [pscustomobject]@{ path = $Control.Receipt; sha256 = $sha; value = $receipt }
}

function Read-Ticket {
    param($ManifestInfo, $Control)
    if (-not (Test-Path -LiteralPath $Control.Ticket -PathType Leaf)) {
        throw "The preparation supervisor ticket does not exist."
    }
    $ticket = Read-PrivateJson $Control.Ticket
    $ticketSha = Get-FileSha256 $Control.Ticket
    if ([int](Get-Value $ticket "schemaVersion" 0) -ne 1 -or
        [string](Get-Value $ticket "type" "") -cne "diagnostic_prep_supervisor_ticket" -or
        [string](Get-Value $ticket "version" "") -cne $script:TicketVersion -or
        [string](Get-Value $ticket "runId" "") -cne $ManifestInfo.RunId) {
        throw "The preparation supervisor ticket identity is invalid."
    }
    $manifestRef = Get-RequiredValue $ticket "manifest"
    $workerRef = Get-RequiredValue $ticket "worker"
    $supervisorScriptRef = Get-RequiredValue $ticket "supervisorScript"
    $launchAdmissionRef = Get-RequiredValue $ticket "launchAdmission"
    $ticketControl = Get-RequiredValue $ticket "control"
    if ([string](Get-Value $manifestRef "path" "") -cne $ManifestInfo.Path -or
        [string](Get-Value $manifestRef "sha256" "") -cne $ManifestInfo.Sha256 -or
        [string](Get-Value $workerRef "path" "") -cne $ManifestInfo.Worker.path -or
        [string](Get-Value $workerRef "sha256" "") -cne $ManifestInfo.Worker.sha256 -or
        [string](Get-Value $supervisorScriptRef "path" "") -cne $script:SelfPath -or
        [string](Get-Value $supervisorScriptRef "sha256" "") -cne (Get-FileSha256 $script:SelfPath) -or
        [string](Get-Value $launchAdmissionRef "path" "") -cne $Control.LaunchAdmission -or
        [string](Get-Value $launchAdmissionRef "sha256" "") -cne (Get-FileSha256 $Control.LaunchAdmission) -or
        [string](Get-Value $ticketControl "statePath" "") -cne $Control.State -or
        [string](Get-Value $ticketControl "resultPath" "") -cne $Control.Result -or
        [string](Get-Value $ticketControl "journalPath" "") -cne $Control.Journal -or
        [string](Get-Value $ticketControl "workerStdoutPath" "") -cne $Control.WorkerStdout -or
        [string](Get-Value $ticketControl "workerStderrPath" "") -cne $Control.WorkerStderr -or
        [string](Get-Value $ticketControl "runMutexName" "") -cne (Get-PreparationMutexName $ManifestInfo.RunId) -or
        [string](Get-Value $ticketControl "supervisorMutexName" "") -cne (Get-SupervisorMutexName $ManifestInfo.RunId) -or
        [string](Get-Value $ticketControl "supervisorLockPath" "") -cne $Control.SupervisorLock) {
        throw "The preparation supervisor ticket bindings changed."
    }
    return [pscustomobject]@{ value = $ticket; sha256 = $ticketSha; path = $Control.Ticket }
}

function New-SupervisorState {
    param(
        $ManifestInfo,
        $TicketInfo,
        [string]$Status,
        $SupervisorIdentity,
        $WorkerIdentity = $null,
        $WorkerObservation = $null,
        $Journal = $null,
        $ResultReference = $null,
        $Failure = $null,
        $Recovery = $null
    )
    $workerValue = $WorkerIdentity
    if ($null -ne $WorkerIdentity -and $null -ne $WorkerObservation) {
        $workerValue = [ordered]@{
            pid = [int](Get-Value $WorkerIdentity "pid" 0)
            startedAtUtc = [string](Get-Value $WorkerIdentity "startedAtUtc" "")
            path = [string](Get-Value $WorkerIdentity "path" "")
            completedAtUtc = [string](Get-Value $WorkerObservation "completedAtUtc" "")
            exitCode = Get-Value $WorkerObservation "exitCode" $null
            timedOut = [bool](Get-Value $WorkerObservation "timedOut" $false)
            exitPersistedBeforeResultParsing = [bool](Get-Value $WorkerObservation "exitPersistedBeforeResultParsing" $false)
        }
    }
    return [ordered]@{
        schemaVersion = 1
        type = "waf800_diagnostic_prep_supervisor_state"
        version = $script:SupervisorVersion
        runId = $ManifestInfo.RunId
        manifestSha256 = $ManifestInfo.Sha256
        status = $Status
        updatedAtUtc = [DateTimeOffset]::UtcNow.ToString("o")
        supervisor = $SupervisorIdentity
        worker = $workerValue
        ticketPath = $TicketInfo.path
        resultPath = if ($null -eq $ResultReference) { $null } else { [string](Get-Value $ResultReference "path" $null) }
        resultSha256 = if ($null -eq $ResultReference) { $null } else { [string](Get-Value $ResultReference "sha256" $null) }
        resultStatus = if ($null -eq $ResultReference) { $null } else { [string](Get-Value $ResultReference "status" $Status) }
        failureCode = if ($null -eq $Failure) { $null } else { [string](Get-Value $Failure "code" $null) }
    }
}

function New-SanitizedFailure {
    param([string]$Code, [string]$Stage, [string]$Message)
    return [ordered]@{
        code = $Code
        stage = $Stage
        messageSha256 = Get-TextSha256 ([string]$Message)
        rawErrorPersisted = $false
    }
}

function Read-LaunchAdmission {
    param(
        $ManifestInfo,
        $Control,
        [string]$ExpectedSha256,
        [string]$Nonce
    )
    $path = Resolve-ExternalPath $LaunchAdmissionPath "LaunchAdmissionPath" File
    if (-not [string]::Equals($path, $Control.LaunchAdmission, [StringComparison]::OrdinalIgnoreCase)) {
        throw "The launch admission path is not the fixed run-bound control path."
    }
    Assert-PrivateAcl $path "supervisor launch admission"
    $expectedSha = Assert-Sha256 $ExpectedSha256 "ExpectedLaunchAdmissionSha256"
    if ((Get-FileSha256 $path) -cne $expectedSha) {
        throw "The immutable supervisor launch admission changed."
    }
    $admission = Read-PrivateJson $path
    $expectedKeys = @(
        "schemaVersion","type","version","runId","createdAtUtc","manifest","worker",
        "supervisorScript","launchNonceSha256","timeoutSeconds","control"
    )
    if (@(Compare-Object ($expectedKeys | Sort-Object) `
            (@($admission.PSObject.Properties.Name) | Sort-Object)).Count -ne 0) {
        throw "The supervisor launch admission fields are invalid."
    }
    $manifestRef = Get-RequiredValue $admission "manifest"
    $workerRef = Get-RequiredValue $admission "worker"
    $supervisorRef = Get-RequiredValue $admission "supervisorScript"
    $controlRef = Get-RequiredValue $admission "control"
    $createdAt = [DateTimeOffset]::MinValue
    if ([int](Get-Value $admission "schemaVersion" 0) -ne 1 -or
        [string](Get-Value $admission "type" "") -cne "diagnostic_prep_supervisor_launch_admission" -or
        [string](Get-Value $admission "version" "") -cne $script:LaunchAdmissionVersion -or
        [string](Get-Value $admission "runId" "") -cne $ManifestInfo.RunId -or
        [string](Get-Value $manifestRef "path" "") -cne $ManifestInfo.Path -or
        [string](Get-Value $manifestRef "sha256" "") -cne $ManifestInfo.Sha256 -or
        [string](Get-Value $workerRef "path" "") -cne $ManifestInfo.Worker.path -or
        [string](Get-Value $workerRef "sha256" "") -cne $ManifestInfo.Worker.sha256 -or
        [string](Get-Value $supervisorRef "path" "") -cne $script:SelfPath -or
        [string](Get-Value $supervisorRef "sha256" "") -cne (Get-FileSha256 $script:SelfPath) -or
        [string](Get-Value $admission "launchNonceSha256" "") -cne (Get-TextSha256 $Nonce) -or
        [int](Get-Value $admission "timeoutSeconds" 0) -ne $SupervisorTimeoutSeconds -or
        [string](Get-Value $controlRef "ticketPath" "") -cne $Control.Ticket -or
        [string](Get-Value $controlRef "statePath" "") -cne $Control.State -or
        [string](Get-Value $controlRef "resultPath" "") -cne $Control.Result -or
        [string](Get-Value $controlRef "journalPath" "") -cne $Control.Journal -or
        [string](Get-Value $controlRef "workerStdoutPath" "") -cne $Control.WorkerStdout -or
        [string](Get-Value $controlRef "workerStderrPath" "") -cne $Control.WorkerStderr -or
        [string](Get-Value $controlRef "supervisorStdoutPath" "") -cne $Control.SupervisorStdout -or
        [string](Get-Value $controlRef "supervisorStderrPath" "") -cne $Control.SupervisorStderr -or
        [string](Get-Value $controlRef "runMutexName" "") -cne (Get-PreparationMutexName $ManifestInfo.RunId) -or
        [string](Get-Value $controlRef "supervisorMutexName" "") -cne (Get-SupervisorMutexName $ManifestInfo.RunId) -or
        [string](Get-Value $controlRef "supervisorLockPath" "") -cne $Control.SupervisorLock -or
        -not [DateTimeOffset]::TryParseExact(
            [string](Get-Value $admission "createdAtUtc" ""), "o",
            [Globalization.CultureInfo]::InvariantCulture,
            [Globalization.DateTimeStyles]::None, [ref]$createdAt
        ) -or $createdAt.Offset -ne [TimeSpan]::Zero -or
        $createdAt -gt [DateTimeOffset]::UtcNow.AddMinutes(1) -or
        $createdAt -lt [DateTimeOffset]::UtcNow.AddMinutes(-5)) {
        throw "The supervisor launch admission identity is invalid."
    }
    return [pscustomobject]@{ path = $path; sha256 = $expectedSha; value = $admission }
}

function Publish-LaunchPresence {
    param($ManifestInfo, $Control, $LaunchAdmission)
    $identity = Get-ProcessIdentity (Get-Process -Id $PID)
    $presence = [ordered]@{
        schemaVersion = 1
        type = "diagnostic_prep_supervisor_launch_presence"
        version = $script:LaunchPresenceVersion
        runId = $ManifestInfo.RunId
        createdAtUtc = [DateTimeOffset]::UtcNow.ToString("o")
        manifestSha256 = $ManifestInfo.Sha256
        launchAdmissionSha256 = $LaunchAdmission.sha256
        supervisor = $identity
    }
    Write-PrivateJson $Control.LaunchPresence $presence -Immutable
    return [pscustomobject]@{
        path = $Control.LaunchPresence
        sha256 = Get-FileSha256 $Control.LaunchPresence
        value = $presence
    }
}

function Read-LaunchPresence {
    param($ManifestInfo, $Control)
    if (-not (Test-Path -LiteralPath $Control.LaunchPresence -PathType Leaf)) { return $null }
    Assert-PrivateAcl $Control.LaunchPresence "supervisor launch presence"
    $presence = Read-PrivateJson $Control.LaunchPresence
    Assert-PreparationExactKeys $presence @(
        "schemaVersion","type","version","runId","createdAtUtc","manifestSha256",
        "launchAdmissionSha256","supervisor"
    ) "supervisor launch presence"
    $supervisor = Get-RequiredValue $presence "supervisor"
    Assert-PreparationExactKeys $supervisor @("pid","startedAtUtc","path") `
        "supervisor launch presence process"
    $createdAt = [DateTimeOffset]::MinValue
    if ([int](Get-Value $presence "schemaVersion" 0) -ne 1 -or
        [string](Get-Value $presence "type" "") -cne "diagnostic_prep_supervisor_launch_presence" -or
        [string](Get-Value $presence "version" "") -cne $script:LaunchPresenceVersion -or
        [string](Get-Value $presence "runId" "") -cne $ManifestInfo.RunId -or
        [string](Get-Value $presence "manifestSha256" "") -cne $ManifestInfo.Sha256 -or
        -not (Test-Path -LiteralPath $Control.LaunchAdmission -PathType Leaf) -or
        [string](Get-Value $presence "launchAdmissionSha256" "") -cne
            (Get-FileSha256 $Control.LaunchAdmission) -or
        [int](Get-Value $supervisor "pid" 0) -le 0 -or
        [string]::IsNullOrWhiteSpace([string](Get-Value $supervisor "startedAtUtc" "")) -or
        [string]::IsNullOrWhiteSpace([string](Get-Value $supervisor "path" "")) -or
        -not [DateTimeOffset]::TryParseExact(
            [string](Get-Value $presence "createdAtUtc" ""), "o",
            [Globalization.CultureInfo]::InvariantCulture,
            [Globalization.DateTimeStyles]::None, [ref]$createdAt
        ) -or $createdAt.Offset -ne [TimeSpan]::Zero -or
        $createdAt -gt [DateTimeOffset]::UtcNow.AddMinutes(1) -or
        $createdAt -lt [DateTimeOffset]::UtcNow.AddMinutes(-10)) {
        throw "The child-authored supervisor launch presence is invalid."
    }
    return [pscustomobject]@{
        path = $Control.LaunchPresence
        sha256 = Get-FileSha256 $Control.LaunchPresence
        value = $presence
    }
}

function Read-RecoveryAdmissionStatus {
    param($ManifestInfo, $Control, $Ticket)
    if (-not (Test-Path -LiteralPath $Control.RecoveryAdmission -PathType Leaf)) { return $null }
    Assert-PrivateAcl $Control.RecoveryAdmission "publication-recovery admission"
    $admission = Read-PrivateJson $Control.RecoveryAdmission
    Assert-PreparationExactKeys $admission @(
        "schemaVersion","type","version","mode","runId","createdAtUtc","manifest","worker",
        "supervisorScript","supervisor","originalTicket","originalExecution",
        "recoveryNonceSha256","control"
    ) "publication-recovery admission"
    $manifest = Get-RequiredValue $admission "manifest"
    $worker = Get-RequiredValue $admission "worker"
    $supervisorScript = Get-RequiredValue $admission "supervisorScript"
    $supervisor = Get-RequiredValue $admission "supervisor"
    $originalTicket = Get-RequiredValue $admission "originalTicket"
    $originalExecution = Get-RequiredValue $admission "originalExecution"
    # PowerShell variable names are case-insensitive.  Keep the admission's
    # nested control binding distinct from the run-level $Control object so
    # exact run paths (not prefix-resolved child properties) are validated.
    $controlBinding = Get-RequiredValue $admission "control"
    Assert-PreparationExactKeys $manifest @("path","sha256") "recovery manifest reference"
    Assert-PreparationExactKeys $worker @("path","sha256") "recovery worker reference"
    Assert-PreparationExactKeys $supervisorScript @("path","sha256") "recovery supervisor-script reference"
    Assert-PreparationExactKeys $supervisor @("pid","startedAtUtc","path") "recovery supervisor identity"
    Assert-PreparationExactKeys $originalTicket @("path","sha256") "recovery original-ticket reference"
    Assert-PreparationExactKeys $originalExecution @(
        "statePath","stateSha256","resultPath","resultSha256",
        "fixturePreparationReceiptPath","fixturePreparationReceiptSha256"
    ) "recovery original-execution reference"
    Assert-PreparationExactKeys $controlBinding @(
        "statePath","recoveryResultPath","recoveryStdoutPath","recoveryStderrPath",
        "runMutexName","supervisorMutexName","supervisorLockPath"
    ) "recovery control"
    $createdAt = [DateTimeOffset]::MinValue
    if ([int](Get-Value $admission "schemaVersion" 0) -ne 1 -or
        [string](Get-Value $admission "type" "") -cne "diagnostic_prep_publication_recovery_admission" -or
        [string](Get-Value $admission "version" "") -cne $script:RecoveryAdmissionVersion -or
        [string](Get-Value $admission "mode" "") -cne "ResumePublication" -or
        [string](Get-Value $admission "runId" "") -cne $ManifestInfo.RunId -or
        [string](Get-Value $manifest "path" "") -cne $ManifestInfo.Path -or
        [string](Get-Value $manifest "sha256" "") -cne $ManifestInfo.Sha256 -or
        [string](Get-Value $worker "path" "") -cne $ManifestInfo.Worker.path -or
        [string](Get-Value $worker "sha256" "") -cne $ManifestInfo.Worker.sha256 -or
        [string](Get-Value $supervisorScript "path" "") -cne $script:SelfPath -or
        [string](Get-Value $supervisorScript "sha256" "") -cne (Get-FileSha256 $script:SelfPath) -or
        [int](Get-Value $supervisor "pid" 0) -le 0 -or
        [string](Get-Value $originalTicket "path" "") -cne $Ticket.path -or
        [string](Get-Value $originalTicket "sha256" "") -cne $Ticket.sha256 -or
        [string](Get-Value $originalExecution "statePath" "") -cne $Control.OriginalState -or
        [string](Get-Value $originalExecution "resultPath" "") -cne $Control.Result -or
        [string](Get-Value $originalExecution "fixturePreparationReceiptPath" "") -cne $Control.Receipt -or
        [string](Get-Value $controlBinding "statePath" "") -cne $Control.State -or
        [string](Get-Value $controlBinding "recoveryResultPath" "") -cne $Control.RecoveryResult -or
        [string](Get-Value $controlBinding "recoveryStdoutPath" "") -cne $Control.RecoveryStdout -or
        [string](Get-Value $controlBinding "recoveryStderrPath" "") -cne $Control.RecoveryStderr -or
        [string](Get-Value $controlBinding "runMutexName" "") -cne (Get-PreparationMutexName $ManifestInfo.RunId) -or
        [string](Get-Value $controlBinding "supervisorMutexName" "") -cne (Get-SupervisorMutexName $ManifestInfo.RunId) -or
        [string](Get-Value $controlBinding "supervisorLockPath" "") -cne $Control.SupervisorLock -or
        [string](Get-Value $admission "recoveryNonceSha256" "") -cnotmatch '^[0-9a-f]{64}$' -or
        [string](Get-Value $originalExecution "stateSha256" "") -cnotmatch '^[0-9a-f]{64}$' -or
        [string](Get-Value $originalExecution "resultSha256" "") -cnotmatch '^[0-9a-f]{64}$' -or
        [string](Get-Value $originalExecution "fixturePreparationReceiptSha256" "") -cnotmatch '^[0-9a-f]{64}$' -or
        -not [DateTimeOffset]::TryParseExact(
            [string](Get-Value $admission "createdAtUtc" ""), "o",
            [Globalization.CultureInfo]::InvariantCulture,
            [Globalization.DateTimeStyles]::None, [ref]$createdAt
        ) -or $createdAt.Offset -ne [TimeSpan]::Zero -or
        $createdAt -gt [DateTimeOffset]::UtcNow.AddMinutes(1)) {
        throw "The publication-recovery admission identity is invalid."
    }
    foreach ($boundArtifact in @(
            [pscustomobject]@{
                Path = [string](Get-RequiredValue $originalExecution "resultPath")
                Sha256 = [string](Get-RequiredValue $originalExecution "resultSha256")
                Label = "recovery-bound original result"
            },
            [pscustomobject]@{
                Path = [string](Get-RequiredValue $originalExecution "fixturePreparationReceiptPath")
                Sha256 = [string](Get-RequiredValue $originalExecution "fixturePreparationReceiptSha256")
                Label = "recovery-bound fixture preparation receipt"
            }
        )) {
        if (-not (Test-Path -LiteralPath $boundArtifact.Path -PathType Leaf)) {
            throw "The publication-recovery admission references a missing immutable artifact."
        }
        Assert-PrivateAcl $boundArtifact.Path $boundArtifact.Label
        if ((Get-FileSha256 $boundArtifact.Path) -cne $boundArtifact.Sha256) {
            throw "A publication-recovery admission artifact changed after admission."
        }
    }
    $admittedOriginalStatePath = [string](Get-RequiredValue $originalExecution "statePath")
    $observableOriginalStatePath = if (Test-Path -LiteralPath $admittedOriginalStatePath -PathType Leaf) {
        $admittedOriginalStatePath
    }
    elseif (Test-Path -LiteralPath $Control.State -PathType Leaf) {
        # The immutable recovery admission is deliberately the first recovery
        # mutation.  Until OriginalState is published, the current state is
        # still the exact admitted original-state byte sequence.
        $Control.State
    }
    else { $null }
    if ($null -eq $observableOriginalStatePath) {
        throw "The publication-recovery admission has no observable original state."
    }
    Assert-PrivateAcl $observableOriginalStatePath "recovery-bound original state"
    if ((Get-FileSha256 $observableOriginalStatePath) -cne
        [string](Get-RequiredValue $originalExecution "stateSha256")) {
        throw "The publication-recovery original state changed after admission."
    }
    return [pscustomobject]@{
        path = $Control.RecoveryAdmission
        sha256 = Get-FileSha256 $Control.RecoveryAdmission
        value = $admission
    }
}

function Publish-ChildAuthoredTicket {
    param($ManifestInfo, $Control, $LaunchAdmission, [string]$Nonce)
    $identity = Get-ProcessIdentity (Get-Process -Id $PID)
    $ticket = [ordered]@{
        schemaVersion = 1
        type = "diagnostic_prep_supervisor_ticket"
        version = $script:TicketVersion
        runId = $ManifestInfo.RunId
        createdAtUtc = [DateTimeOffset]::UtcNow.ToString("o")
        diagnosticOnly = $true
        diagnosticEligible = $ManifestInfo.DiagnosticEligible
        certificationEligible = $false
        manifest = [ordered]@{ path = $ManifestInfo.Path; sha256 = $ManifestInfo.Sha256 }
        worker = [ordered]@{ path = $ManifestInfo.Worker.path; sha256 = $ManifestInfo.Worker.sha256 }
        supervisorScript = [ordered]@{ path = $script:SelfPath; sha256 = Get-FileSha256 $script:SelfPath }
        launchAdmission = [ordered]@{ path = $LaunchAdmission.path; sha256 = $LaunchAdmission.sha256 }
        supervisor = $identity
        launchNonceSha256 = Get-TextSha256 $Nonce
        timeoutSeconds = $SupervisorTimeoutSeconds
        control = [ordered]@{
            statePath = $Control.State
            resultPath = $Control.Result
            journalPath = $Control.Journal
            workerStdoutPath = $Control.WorkerStdout
            workerStderrPath = $Control.WorkerStderr
            supervisorStdoutPath = $Control.SupervisorStdout
            supervisorStderrPath = $Control.SupervisorStderr
            runMutexName = Get-PreparationMutexName $ManifestInfo.RunId
            supervisorMutexName = Get-SupervisorMutexName $ManifestInfo.RunId
            supervisorLockPath = $Control.SupervisorLock
        }
    }
    Write-PrivateJson $Control.Ticket $ticket -Immutable
    return Read-Ticket $ManifestInfo $Control
}

function Invoke-ValidateMode {
    param($ManifestInfo)
    $workerValidation = Invoke-WorkerValidation $ManifestInfo
    Assert-NoPreparationDownstreamArtifacts $ManifestInfo
    return [ordered]@{
        schemaVersion = 1
        type = "diagnostic_prep_supervisor_validation"
        version = $script:SupervisorVersion
        valid = $true
        mode = "Validate"
        runId = $ManifestInfo.RunId
        manifest = [ordered]@{ path = $ManifestInfo.Path; sha256 = $ManifestInfo.Sha256 }
        worker = [ordered]@{ path = $ManifestInfo.Worker.path; sha256 = $ManifestInfo.Worker.sha256 }
        diagnosticEligible = $ManifestInfo.DiagnosticEligible
        mutationStarted = $false
        trafficStarted = $false
        leaseAcquired = $false
        workerValidationSha256 = Get-TextSha256 ($workerValidation | ConvertTo-Json -Depth 60 -Compress)
    }
}

function Invoke-StartMode {
    param($ManifestInfo, $Control)
    New-PrivateDirectory $ManifestInfo.RunRoot
    $stateParent = [IO.Path]::GetDirectoryName($ManifestInfo.StatePath)
    if (-not [string]::Equals($stateParent, $ManifestInfo.RunRoot, [StringComparison]::OrdinalIgnoreCase)) {
        New-PrivateDirectory $stateParent
    }
    $ticketParent = [IO.Path]::GetDirectoryName($Control.Ticket)
    if (-not [string]::Equals($ticketParent, $ManifestInfo.RunRoot, [StringComparison]::OrdinalIgnoreCase)) {
        New-PrivateDirectory $ticketParent
    }
    foreach ($path in @(
            $Control.LaunchAdmission, $Control.LaunchPresence, $Control.Ticket,
            $Control.State, $Control.Result, $Control.Journal, $Control.Receipt,
            $Control.PublicationRecoveryReceipt,
            $Control.SupervisorStdout, $Control.SupervisorStderr,
            $Control.WorkerStdout, $Control.WorkerStderr,
            $Control.RecoveryStdout, $Control.RecoveryStderr,
            $Control.RecoveryResult, $Control.RecoveryAdmission, $Control.OriginalState,
            $Control.SupervisorLock, $Control.WorkerOwnership, $Control.RecoveryWorkerOwnership
        )) {
        if (Test-Path -LiteralPath $path) { throw "A fresh supervisor control path is required." }
    }
    # The worker is the authority for deep manifest, window, freshness, and
    # provider validation. This call is read-only and precedes the attempt.
    [void](Invoke-WorkerValidation $ManifestInfo)
    # Repeat the downstream fence after validation and immediately before the
    # immutable launch admission.  This closes the validation/admission race;
    # the worker independently repeats it before its first journal mutation.
    Assert-NoPreparationDownstreamArtifacts $ManifestInfo

    $nonce = [Guid]::NewGuid().ToString("N")
    $launchAdmission = [ordered]@{
        schemaVersion = 1
        type = "diagnostic_prep_supervisor_launch_admission"
        version = $script:LaunchAdmissionVersion
        runId = $ManifestInfo.RunId
        createdAtUtc = [DateTimeOffset]::UtcNow.ToString("o")
        manifest = [ordered]@{ path = $ManifestInfo.Path; sha256 = $ManifestInfo.Sha256 }
        worker = [ordered]@{ path = $ManifestInfo.Worker.path; sha256 = $ManifestInfo.Worker.sha256 }
        supervisorScript = [ordered]@{ path = $script:SelfPath; sha256 = Get-FileSha256 $script:SelfPath }
        launchNonceSha256 = Get-TextSha256 $nonce
        timeoutSeconds = $SupervisorTimeoutSeconds
        control = [ordered]@{
            ticketPath = $Control.Ticket
            statePath = $Control.State
            resultPath = $Control.Result
            journalPath = $Control.Journal
            workerStdoutPath = $Control.WorkerStdout
            workerStderrPath = $Control.WorkerStderr
            supervisorStdoutPath = $Control.SupervisorStdout
            supervisorStderrPath = $Control.SupervisorStderr
            runMutexName = Get-PreparationMutexName $ManifestInfo.RunId
            supervisorMutexName = Get-SupervisorMutexName $ManifestInfo.RunId
            supervisorLockPath = $Control.SupervisorLock
        }
    }
    # This immutable admission is the first attempt artifact.  No child can
    # launch and no fixture mutation can begin before it is durable.
    Write-PrivateJson $Control.LaunchAdmission $launchAdmission -Immutable
    $launchAdmissionSha256 = Get-FileSha256 $Control.LaunchAdmission
    New-PrivateEmptyFile $Control.SupervisorStdout
    New-PrivateEmptyFile $Control.SupervisorStderr
    $pwsh = Get-PwshPath
    $arguments = @(
        "-NoProfile", "-NonInteractive", "-WindowStyle", "Hidden",
        "-File", (Quote-ProcessArgument $script:SelfPath),
        "-Mode", "Supervise",
        "-ManifestPath", (Quote-ProcessArgument $ManifestInfo.Path),
        "-ExpectedManifestSha256", $ManifestInfo.Sha256,
        "-TicketPath", (Quote-ProcessArgument $Control.Ticket),
        "-LaunchNonce", $nonce,
        "-LaunchAdmissionPath", (Quote-ProcessArgument $Control.LaunchAdmission),
        "-ExpectedLaunchAdmissionSha256", $launchAdmissionSha256,
        "-SupervisorTimeoutSeconds", ([string]$SupervisorTimeoutSeconds)
    )
    $process = $null
    try {
        # Win32_Process.Create is serviced out-of-band by WMI rather than as a
        # child of this potentially bounded caller.  A successful ticket is
        # published only after both parent and child verify that the supervisor
        # is outside every inherited Windows Job Object.
        $process = Start-DiagnosticPrepOutOfBandProcess -ExecutablePath $pwsh -Arguments $arguments
        $identity = Get-ProcessIdentity $process
        $watch = [Diagnostics.Stopwatch]::StartNew()
        while (-not (Test-Path -LiteralPath $Control.Ticket -PathType Leaf)) {
            $process.Refresh()
            if ($process.HasExited) { throw "The admitted supervisor exited before publishing its ticket." }
            if ($watch.Elapsed.TotalSeconds -ge 30) {
                Stop-BoundProcess $process
                throw "The admitted supervisor did not publish its ticket within the bounded launch window."
            }
            Start-Sleep -Milliseconds 50
        }
        $ticketInfo = Read-Ticket $ManifestInfo $Control
        $launchPresence = Read-LaunchPresence $ManifestInfo $Control
        if ($null -eq $launchPresence) {
            throw "The admitted supervisor did not publish its exact launch presence."
        }
        $ticketSupervisor = Get-RequiredValue $ticketInfo.value "supervisor"
        $presenceSupervisor = Get-RequiredValue $launchPresence.value "supervisor"
        $ticketLaunchAdmission = Get-RequiredValue $ticketInfo.value "launchAdmission"
        if ([string](Get-Value $ticketInfo.value "launchNonceSha256" "") -cne (Get-TextSha256 $nonce) -or
            [string](Get-Value $ticketLaunchAdmission "path" "") -cne $Control.LaunchAdmission -or
            [string](Get-Value $ticketLaunchAdmission "sha256" "") -cne $launchAdmissionSha256 -or
            [int](Get-Value $presenceSupervisor "pid" 0) -ne [int]$identity.pid -or
            [string](Get-Value $presenceSupervisor "startedAtUtc" "") -cne [string]$identity.startedAtUtc -or
            -not [string]::Equals(
                [string](Get-Value $presenceSupervisor "path" ""), [string]$identity.path,
                [StringComparison]::OrdinalIgnoreCase) -or
            [int](Get-Value $ticketSupervisor "pid" 0) -ne [int]$identity.pid -or
            [string](Get-Value $ticketSupervisor "startedAtUtc" "") -cne [string]$identity.startedAtUtc -or
            -not [string]::Equals(
                [string](Get-Value $ticketSupervisor "path" ""), [string]$identity.path,
                [StringComparison]::OrdinalIgnoreCase)) {
            throw "The child-authored supervisor ticket is not bound to the admitted process."
        }
        return [ordered]@{
            schemaVersion = 1
            type = "diagnostic_prep_supervisor_start"
            version = $script:SupervisorVersion
            accepted = $true
            runId = $ManifestInfo.RunId
            manifest = [ordered]@{ path = $ManifestInfo.Path; sha256 = $ManifestInfo.Sha256 }
            launchAdmission = [ordered]@{ path = $Control.LaunchAdmission; sha256 = $launchAdmissionSha256 }
            ticket = [ordered]@{ path = $Control.Ticket; sha256 = $ticketInfo.sha256 }
            supervisor = $identity
            statusPath = $Control.State
            returnedBeforeCompletion = $true
            trafficStarted = $false
            leaseAcquired = $false
        }
    }
    catch {
        # If the ticket exists, the detached child owns the lifecycle and must
        # not be killed by a launcher-side failure or caller timeout.  Before a
        # ticket exists no worker may have launched, so bounded termination is
        # safe and leaves a deterministic admitted/no-ticket state.
        if ($null -ne $process -and -not (Test-Path -LiteralPath $Control.Ticket -PathType Leaf)) {
            Stop-BoundProcess $process
        }
        throw
    }
    finally { if ($null -ne $process) { $process.Dispose() } }
}

function Invoke-SuperviseMode {
    param($ManifestInfo, $Control)
    if ([string]::IsNullOrWhiteSpace($LaunchNonce) -or
        [string]::IsNullOrWhiteSpace($LaunchAdmissionPath) -or
        [string]::IsNullOrWhiteSpace($ExpectedLaunchAdmissionSha256)) {
        throw "The internal supervisor requires its immutable launch admission and nonce."
    }
    $launchAdmission = Read-LaunchAdmission $ManifestInfo $Control `
        $ExpectedLaunchAdmissionSha256 $LaunchNonce
    Assert-DiagnosticPrepProcessOutsideJob (Get-Process -Id $PID)
    # Publish exact process evidence before any offline delay or ticket write.
    # Status can therefore distinguish a live detached launch from a caller or
    # child that disappeared before the normal ticket handshake completed.
    [void](Publish-LaunchPresence $ManifestInfo $Control $launchAdmission)
    $beforeTicketDelay = Get-OfflineTestDelayMilliseconds $ManifestInfo `
        "supervisorBeforeTicketDelayMilliseconds"
    if ($beforeTicketDelay -gt 0) { Start-Sleep -Milliseconds $beforeTicketDelay }
    # The detached child is the sole ticket author. Launch presence is already
    # durable, so caller death cannot leave a spawned but unaddressable child;
    # no preparation worker can launch until this ticket is committed.
    $ticketInfo = Publish-ChildAuthoredTicket $ManifestInfo $Control $launchAdmission $LaunchNonce
    $ticketSupervisor = Get-RequiredValue $ticketInfo.value "supervisor"
    $lock = $null
    $fileLock = $null
    $worker = $null
    $boundWorkerLaunch = $null
    $workerJob = [IntPtr]::Zero
    $workerOwnershipRef = $null
    $workerIdentity = $null
    $workerObservation = $null
    $terminationFailure = $null
    $failure = $null
    $terminalStatus = "failed"
    $powerSet = $false
    try {
        $lock = Enter-NewOwnedMutex (Get-SupervisorMutexName $ManifestInfo.RunId) `
            "Another durable supervisor already owns this preparation run."
        $fileLock = Enter-ExclusiveRunFileLock $ManifestInfo $ticketInfo $Control -Create
        if (Test-Path -LiteralPath $Control.State) {
            throw "The supervisor state already exists; replay is prohibited."
        }
        Set-SleepPrevention $true
        $powerSet = $true
        $initial = New-SupervisorState $ManifestInfo $ticketInfo "launching" $ticketSupervisor
        Write-PrivateJson $Control.State $initial -Immutable
        New-PrivateEmptyFile $Control.WorkerStdout
        New-PrivateEmptyFile $Control.WorkerStderr
        # Create the append-only journal with its final ACL before the worker is
        # admitted.  Status readers must never observe the create-then-ACL race
        # that exists if the first append is also responsible for file creation.
        New-PrivateEmptyFile $Control.Journal
        $pwsh = Get-PwshPath
        $workerArgs = @(
            "-NoProfile", "-File", (Quote-ProcessArgument $ManifestInfo.Worker.path),
            "-Mode", "Run",
            "-ManifestPath", (Quote-ProcessArgument $ManifestInfo.Path),
            "-ExpectedManifestSha256", $ManifestInfo.Sha256,
            "-SupervisorAdmissionPath", (Quote-ProcessArgument $ticketInfo.path),
            "-ExpectedSupervisorAdmissionSha256", $ticketInfo.sha256,
            "-SupervisorAdmissionNonce", $LaunchNonce
        )
        $beforeWorkerCreateDelay = Get-OfflineTestDelayMilliseconds $ManifestInfo `
            "supervisorBeforeWorkerCreateDelayMilliseconds"
        if ($beforeWorkerCreateDelay -gt 0) {
            Start-Sleep -Milliseconds $beforeWorkerCreateDelay
        }
        $workerJob = New-DiagnosticPrepKillOnCloseJob
        $boundWorkerLaunch = Start-DiagnosticPrepSuspendedJobProcess `
            -ExecutablePath $pwsh -Arguments $workerArgs `
            -StandardOutputPath $Control.WorkerStdout `
            -StandardErrorPath $Control.WorkerStderr -JobHandle $workerJob
        $worker = $boundWorkerLaunch.Process
        $workerIdentity = $boundWorkerLaunch.Identity
        $workerOwnership = [ordered]@{
            schemaVersion = 1
            type = "diagnostic_prep_worker_ownership"
            version = $script:WorkerOwnershipVersion
            runId = $ManifestInfo.RunId
            createdAtUtc = [DateTimeOffset]::UtcNow.ToString("o")
            manifestSha256 = $ManifestInfo.Sha256
            supervisorAdmissionSha256 = $ticketInfo.sha256
            supervisor = $ticketSupervisor
            worker = $workerIdentity
            jobPolicy = "kill-on-supervisor-close-v1"
            descendantPolicy = "no-breakaway-v1"
        }
        Write-PrivateJson $Control.WorkerOwnership $workerOwnership -Immutable
        $workerOwnershipRef = [ordered]@{
            path = $Control.WorkerOwnership
            sha256 = Get-FileSha256 $Control.WorkerOwnership
        }
        # This bounded, offline-only control exists solely to make state-file
        # sharing races deterministic in the repository regression suite.  The
        # worker's manifest validator rejects all test controls for an eligible
        # production preparation.
        $testControls = Get-Value $ManifestInfo.Value "testControls" $null
        $afterWorkerJobAssignmentDelay = Get-OfflineTestDelayMilliseconds $ManifestInfo `
            "supervisorAfterWorkerAssignmentBeforeResumeDelayMilliseconds"
        if ($afterWorkerJobAssignmentDelay -gt 0) {
            Start-Sleep -Milliseconds $afterWorkerJobAssignmentDelay
        }
        $beforeRunningStateDelay = if ($null -ne $testControls) {
            [int](Get-Value $testControls "supervisorBeforeRunningStateDelayMilliseconds" 0)
        }
        else { 0 }
        if ($beforeRunningStateDelay -gt 0) {
            Start-Sleep -Milliseconds $beforeRunningStateDelay
        }
        Resume-DiagnosticPrepJobProcess $boundWorkerLaunch
        $runningState = New-SupervisorState $ManifestInfo $ticketInfo "running" $ticketSupervisor $workerIdentity
        $runningState.workerOwnership = $workerOwnershipRef
        $forceStateRetryExhaustion = $null -ne $testControls -and
            (Get-Value $testControls "supervisorForceRunningStateRetryExhaustion" $false) -eq $true
        if ($forceStateRetryExhaustion) {
            $conflictingReader = [IO.FileStream]::new(
                $Control.State, [IO.FileMode]::Open, [IO.FileAccess]::Read, [IO.FileShare]::ReadWrite
            )
            try { Write-PrivateJson $Control.State $runningState }
            finally { $conflictingReader.Dispose() }
        }
        else { Write-PrivateJson $Control.State $runningState }

        $watch = [Diagnostics.Stopwatch]::StartNew()
        $timedOut = $false
        while (-not $worker.HasExited) {
            if ($watch.Elapsed.TotalSeconds -ge $SupervisorTimeoutSeconds) {
                $timedOut = $true
                # Closing the owning Job Object is the primary termination
                # action: Windows then kills the worker and every descendant.
                Close-DiagnosticPrepJob $workerJob
                $workerJob = [IntPtr]::Zero
                if (-not $worker.WaitForExit(10000)) {
                    Stop-BoundProcess $worker
                    if (-not $worker.WaitForExit(10000)) {
                        throw "The supervised fixture worker tree could not be terminated within the bounded grace period."
                    }
                }
                break
            }
            Start-Sleep -Milliseconds 250
            $worker.Refresh()
        }
        $worker.WaitForExit()
        $completedAt = [DateTimeOffset]::UtcNow.ToString("o")
        $exitCode = $null
        try { $exitCode = $worker.ExitCode } catch { }
        $workerObservation = [ordered]@{
            pid = $workerIdentity.pid
            startedAtUtc = $workerIdentity.startedAtUtc
            path = $workerIdentity.path
            completedAtUtc = $completedAt
            exitCode = $exitCode
            timedOut = $timedOut
            exitPersistedBeforeResultParsing = $true
        }
        # This commit is intentionally before reading worker output, the
        # journal, receipt, or snapshot. It preserves the missing exit evidence
        # that invalidated the historical run.
        $exitedState = New-SupervisorState $ManifestInfo $ticketInfo "worker_exited" `
            $ticketSupervisor $workerIdentity $workerObservation
        $exitedState.workerOwnership = $workerOwnershipRef
        Write-PrivateJson $Control.State $exitedState
        $afterWorkerExitedStateDelay = Get-OfflineTestDelayMilliseconds $ManifestInfo `
            "supervisorAfterWorkerExitedStateDelayMilliseconds"
        if ($afterWorkerExitedStateDelay -gt 0) {
            Start-Sleep -Milliseconds $afterWorkerExitedStateDelay
        }

        Assert-PrivateAcl $Control.WorkerStdout "fixture-worker stdout"
        Assert-PrivateAcl $Control.WorkerStderr "fixture-worker stderr"
        if ($timedOut) { throw [TimeoutException]::new("The fixture preparation worker exceeded its bound runtime.") }
        if ($null -eq $exitCode -or $exitCode -ne 0) {
            $exitJournal = $null
            try { $exitJournal = Read-JournalStatus $ManifestInfo $Control } catch { }
            if ($null -eq $exitJournal -or
                [string](Get-Value $exitJournal "lastStage" "") -cne "terminal_commit") {
                $terminalStatus = "interrupted"
            }
            throw "The fixture preparation worker exited nonzero."
        }
        $stderr = Get-Content -LiteralPath $Control.WorkerStderr -Raw
        if (-not [string]::IsNullOrWhiteSpace($stderr)) { throw "The fixture preparation worker emitted stderr." }
        $stdout = Get-Content -LiteralPath $Control.WorkerStdout -Raw
        try { $workerResult = $stdout | ConvertFrom-Json -DateKind String -Depth 60 -ErrorAction Stop }
        catch { throw "The fixture preparation worker result is malformed." }
        if ($workerResult -is [Array] -or
            (Get-Value $workerResult "valid" $false) -ne $true -or
            [string](Get-Value $workerResult "runId" "") -cne $ManifestInfo.RunId -or
            [string](Get-Value $workerResult "manifestSha256" "") -cne $ManifestInfo.Sha256 -or
            [string](Get-Value $workerResult "status" "") -cne "completed" -or
            (Get-Value $workerResult "trafficStarted" $true) -ne $false -or
            (Get-Value $workerResult "leaseAcquired" $true) -ne $false) {
            throw "The fixture preparation worker did not return a bound no-traffic completion."
        }
        $journal = Read-JournalStatus $ManifestInfo $Control -RequireTerminal
        $receipt = Read-PreparationReceiptStatus $ManifestInfo $Control -Required
        $receiptVerification = Get-RequiredValue $receipt.value "verification"
        $verificationCountsAndGatesSha256 = Assert-Sha256 `
            ([string](Get-RequiredValue $receiptVerification "countsAndGatesSha256")) `
            "fixture verification counts/gates sha256"
        if ([string](Get-Value $workerResult "journalTerminalHash" "") -cne $journal.lastRecordHash -or
            [string](Get-Value $workerResult "fixturePreparationReceiptSha256" "") -cne $receipt.sha256 -or
            [string](Get-Value $workerResult "supervisorAdmissionSha256" "") -cne $ticketInfo.sha256 -or
            [string](Get-Value $workerResult "verificationCountsAndGatesSha256" "") -cne
                $verificationCountsAndGatesSha256) {
            throw "The worker result does not match the sealed journal and preparation receipt."
        }
        $terminalStatus = "completed"
        $result = [ordered]@{
            schemaVersion = 1
            type = "waf800_diagnostic_prep_supervisor_result"
            version = $script:SupervisorVersion
            runId = $ManifestInfo.RunId
            manifest = [ordered]@{ path = $ManifestInfo.Path; sha256 = $ManifestInfo.Sha256 }
            ticket = [ordered]@{ path = $ticketInfo.path; sha256 = $ticketInfo.sha256 }
            supervisorRunLock = [ordered]@{ path = $fileLock.path; sha256 = $fileLock.sha256 }
            supervisorAdmissionSha256 = $ticketInfo.sha256
            verificationCountsAndGatesSha256 = $verificationCountsAndGatesSha256
            status = "completed"
            completedAtUtc = [DateTimeOffset]::UtcNow.ToString("o")
            supervisor = $ticketSupervisor
            worker = $workerObservation
            workerOwnership = $workerOwnershipRef
            journal = [ordered]@{
                path = $Control.Journal; recordCount = $journal.recordCount
                sha256 = $journal.sha256
                terminalHash = $journal.lastRecordHash; terminalCommitted = $true
            }
            fixturePreparationReceipt = [ordered]@{ path = $receipt.path; sha256 = $receipt.sha256 }
            workerResultSha256 = Get-TextSha256 ($workerResult | ConvertTo-Json -Depth 60 -Compress)
            terminalEvidenceCommitted = $true
            trafficStarted = $false
            leaseAcquired = $false
            rawErrorPersisted = $false
        }
        Write-PrivateJson $Control.Result $result -Immutable
        $resultRef = [ordered]@{ path = $Control.Result; sha256 = Get-FileSha256 $Control.Result }
        $afterResultCommitDelay = Get-OfflineTestDelayMilliseconds $ManifestInfo `
            "supervisorAfterResultCommitDelayMilliseconds"
        if ($afterResultCommitDelay -gt 0) {
            Start-Sleep -Milliseconds $afterResultCommitDelay
        }
        $state = New-SupervisorState $ManifestInfo $ticketInfo "completed" $ticketSupervisor `
            $workerIdentity $workerObservation $journal $resultRef
        $state.workerOwnership = $workerOwnershipRef
        Write-PrivateJson $Control.State $state
        return $result
    }
    catch {
        $caught = $_
        if ($caught.Exception -is [TimeoutException]) { $terminalStatus = "timed_out" }
        if ($null -ne $worker) {
            try {
                if (-not $worker.HasExited) {
                    Close-DiagnosticPrepJob $workerJob
                    $workerJob = [IntPtr]::Zero
                    if (-not $worker.WaitForExit(10000)) {
                        Stop-BoundProcess $worker
                        if (-not $worker.WaitForExit(10000)) {
                            $terminalStatus = "interrupted"
                            throw "The supervised fixture worker tree remained alive after bounded termination."
                        }
                    }
                }
                else { $worker.WaitForExit() }
                if ($null -eq $workerObservation -and $null -ne $workerIdentity) {
                    $capturedExitCode = $null
                    try { $capturedExitCode = $worker.ExitCode } catch { }
                    $workerObservation = [ordered]@{
                        pid = $workerIdentity.pid
                        startedAtUtc = $workerIdentity.startedAtUtc
                        path = $workerIdentity.path
                        completedAtUtc = [DateTimeOffset]::UtcNow.ToString("o")
                        exitCode = $capturedExitCode
                        timedOut = ($terminalStatus -eq "timed_out")
                        exitPersistedBeforeResultParsing = $true
                    }
                    $exitedState = New-SupervisorState $ManifestInfo $ticketInfo "worker_exited" `
                        $ticketSupervisor $workerIdentity $workerObservation
                    $exitedState.workerOwnership = $workerOwnershipRef
                    Write-PrivateJson $Control.State $exitedState
                }
            }
            catch { $terminationFailure = $_ }
        }
        if ($null -ne $terminationFailure) {
            $terminalStatus = "interrupted"
            $caught = $terminationFailure
        }
        $failureCode = if ($null -ne $terminationFailure) { "fixture_preparation_worker_termination_failed" }
        elseif ($terminalStatus -eq "timed_out") { "fixture_preparation_worker_timeout" }
        elseif ($terminalStatus -eq "interrupted") { "fixture_preparation_worker_interrupted" }
        else { "fixture_preparation_supervisor_failed" }
        $failure = New-SanitizedFailure $failureCode "fixture_preparation" $caught.Exception.Message
        $journal = $null
        try { $journal = Read-JournalStatus $ManifestInfo $Control } catch { }
        $result = [ordered]@{
            schemaVersion = 1
            type = "waf800_diagnostic_prep_supervisor_result"
            version = $script:SupervisorVersion
            runId = $ManifestInfo.RunId
            manifest = [ordered]@{ path = $ManifestInfo.Path; sha256 = $ManifestInfo.Sha256 }
            ticket = [ordered]@{ path = $ticketInfo.path; sha256 = $ticketInfo.sha256 }
            supervisorRunLock = if ($null -eq $fileLock) { $null } else {
                [ordered]@{ path = $fileLock.path; sha256 = $fileLock.sha256 }
            }
            status = $terminalStatus
            completedAtUtc = [DateTimeOffset]::UtcNow.ToString("o")
            supervisor = $ticketSupervisor
            worker = $workerObservation
            workerOwnership = $workerOwnershipRef
            journal = $journal
            failure = $failure
            terminalEvidenceCommitted = $true
            trafficStarted = $false
            leaseAcquired = $false
            rawErrorPersisted = $false
        }
        $resultRef = $null
        $committedFailureResult = $false
        try {
            if (-not (Test-Path -LiteralPath $Control.Result)) {
                Write-PrivateJson $Control.Result $result -Immutable
                $resultRef = [ordered]@{ path = $Control.Result; sha256 = Get-FileSha256 $Control.Result }
                $committedFailureResult = $true
            }
        }
        catch { }
        if ($committedFailureResult) {
            $afterResultCommitDelay = Get-OfflineTestDelayMilliseconds $ManifestInfo `
                "supervisorAfterResultCommitDelayMilliseconds"
            if ($afterResultCommitDelay -gt 0) {
                Start-Sleep -Milliseconds $afterResultCommitDelay
            }
        }
        try {
            $state = New-SupervisorState $ManifestInfo $ticketInfo $terminalStatus $ticketSupervisor `
                $workerIdentity $workerObservation $journal $resultRef $failure
            $state.workerOwnership = $workerOwnershipRef
            if (Test-Path -LiteralPath $Control.State) { Write-PrivateJson $Control.State $state }
            else { Write-PrivateJson $Control.State $state -Immutable }
        }
        catch { }
        return $result
    }
    finally {
        Close-DiagnosticPrepJob $workerJob
        if ($null -ne $boundWorkerLaunch -and $boundWorkerLaunch.Resumed -ne $true) {
            $boundWorkerLaunch.NativeLaunch.Dispose()
        }
        if ($null -ne $worker) { $worker.Dispose() }
        if ($powerSet) { try { Set-SleepPrevention $false } catch { } }
        if ($null -ne $fileLock) { $fileLock.stream.Dispose() }
        Exit-OwnedMutex $lock
    }
}

function Assert-StateIdentity {
    param($ManifestInfo, $TicketInfo, $State)
    if ([int](Get-Value $State "schemaVersion" 0) -ne 1 -or
        [string](Get-Value $State "type" "") -cne "waf800_diagnostic_prep_supervisor_state" -or
        [string](Get-Value $State "version" "") -cne $script:SupervisorVersion -or
        [string](Get-Value $State "runId" "") -cne $ManifestInfo.RunId -or
        [string](Get-Value $State "manifestSha256" "") -cne $ManifestInfo.Sha256) {
        throw "The preparation supervisor state identity is invalid."
    }
    if ([string](Get-Value $State "ticketPath" "") -cne $TicketInfo.path) {
        throw "The preparation supervisor state is not bound to its immutable ticket."
    }
    $ticketSupervisor = Get-RequiredValue $TicketInfo.value "supervisor"
    $boundExecution = Get-Value $State "originalExecution" $State
    $stateSupervisor = Get-RequiredValue $boundExecution "supervisor"
    if ([int](Get-Value $stateSupervisor "pid" 0) -ne [int](Get-Value $ticketSupervisor "pid" 0) -or
        [string](Get-Value $stateSupervisor "startedAtUtc" "") -cne
            [string](Get-Value $ticketSupervisor "startedAtUtc" "") -or
        -not [string]::Equals(
            [string](Get-Value $stateSupervisor "path" ""),
            [string](Get-Value $ticketSupervisor "path" ""),
            [StringComparison]::OrdinalIgnoreCase
        )) {
        throw "The preparation supervisor state process is not bound to its ticket."
    }
}

function Test-IsTerminalState {
    param([string]$Status)
    return $Status -in @("completed", "failed", "timed_out", "interrupted")
}

function Test-ProcessObservationEqual {
    param($Left, $Right)
    if ($null -eq $Left -or $null -eq $Right) { return $false }
    return [int](Get-Value $Left "pid" 0) -eq [int](Get-Value $Right "pid" 0) -and
        [string](Get-Value $Left "startedAtUtc" "") -ceq [string](Get-Value $Right "startedAtUtc" "") -and
        [string]::Equals(
            [string](Get-Value $Left "path" ""), [string](Get-Value $Right "path" ""),
            [StringComparison]::OrdinalIgnoreCase
        ) -and
        [string](Get-Value $Left "completedAtUtc" "") -ceq [string](Get-Value $Right "completedAtUtc" "") -and
        (Get-Value $Left "exitCode" $null) -eq (Get-Value $Right "exitCode" $null) -and
        [bool](Get-Value $Left "timedOut" $false) -eq [bool](Get-Value $Right "timedOut" $false) -and
        [bool](Get-Value $Left "exitPersistedBeforeResultParsing" $false) -eq
            [bool](Get-Value $Right "exitPersistedBeforeResultParsing" $false)
}

function Test-ProcessIdentityEqual {
    param($Left, $Right)
    if ($null -eq $Left -or $null -eq $Right) { return $false }
    return [int](Get-Value $Left "pid" 0) -eq [int](Get-Value $Right "pid" 0) -and
        [string](Get-Value $Left "startedAtUtc" "") -ceq
            [string](Get-Value $Right "startedAtUtc" "") -and
        [string]::Equals(
            [string](Get-Value $Left "path" ""), [string](Get-Value $Right "path" ""),
            [StringComparison]::OrdinalIgnoreCase
        )
}

function Test-EvidenceReferenceEqual {
    param($Left, $Right)
    if ($null -eq $Left -or $null -eq $Right) { return $null -eq $Left -and $null -eq $Right }
    return [string](Get-Value $Left "path" "") -ceq [string](Get-Value $Right "path" "") -and
        [string](Get-Value $Left "sha256" "") -ceq [string](Get-Value $Right "sha256" "")
}

function Assert-ReconcilableInitialResult {
    param(
        $ManifestInfo,
        $Control,
        $Ticket,
        $State,
        $Result,
        [switch]$HistoricalJournal
    )
    $ticketSupervisor = Get-RequiredValue $Ticket.value "supervisor"
    $resultSupervisor = Get-RequiredValue $Result "supervisor"
    $resultWorker = Get-Value $Result "worker" $null
    $stateWorker = Get-Value $State "worker" $null
    $resultOwnership = Get-Value $Result "workerOwnership" $null
    $stateOwnership = Get-Value $State "workerOwnership" $null
    $status = [string](Get-RequiredValue $Result "status")
    if ([int](Get-Value $Result "schemaVersion" 0) -ne 1 -or
        [string](Get-Value $Result "type" "") -cne "waf800_diagnostic_prep_supervisor_result" -or
        [string](Get-Value $Result "version" "") -cne $script:SupervisorVersion -or
        [string](Get-Value $Result "runId" "") -cne $ManifestInfo.RunId -or
        $status -notin @("completed","failed","timed_out","interrupted") -or
        (Get-Value $Result "terminalEvidenceCommitted" $false) -ne $true -or
        (Get-Value $Result "trafficStarted" $true) -ne $false -or
        (Get-Value $Result "leaseAcquired" $true) -ne $false -or
        (Get-Value $Result "rawErrorPersisted" $true) -ne $false -or
        [string](Get-Value (Get-RequiredValue $Result "manifest") "path" "") -cne $ManifestInfo.Path -or
        [string](Get-Value (Get-RequiredValue $Result "manifest") "sha256" "") -cne $ManifestInfo.Sha256 -or
        [string](Get-Value (Get-RequiredValue $Result "ticket") "path" "") -cne $Ticket.path -or
        [string](Get-Value (Get-RequiredValue $Result "ticket") "sha256" "") -cne $Ticket.sha256 -or
        [int](Get-Value $resultSupervisor "pid" 0) -ne [int](Get-Value $ticketSupervisor "pid" 0) -or
        [string](Get-Value $resultSupervisor "startedAtUtc" "") -cne
            [string](Get-Value $ticketSupervisor "startedAtUtc" "") -or
        -not [string]::Equals(
            [string](Get-Value $resultSupervisor "path" ""),
            [string](Get-Value $ticketSupervisor "path" ""),
            [StringComparison]::OrdinalIgnoreCase
        )) {
        throw "The immutable supervisor result cannot be reconciled with the persisted worker exit."
    }
    if (($null -eq $resultWorker) -ne ($null -eq $stateWorker)) {
        throw "The immutable supervisor result worker presence differs from the persisted state."
    }
    if ($null -ne $resultWorker) {
        $processLost = (Get-Value $resultWorker "processLost" $false) -eq $true
        if ($processLost) {
            if ($status -cne "interrupted" -or
                -not (Test-ProcessIdentityEqual $resultWorker $stateWorker) -or
                $null -ne (Get-Value $resultWorker "exitCode" $null) -or
                (Get-Value $resultWorker "exitPersistedBeforeResultParsing" $true) -ne $false) {
                throw "The process-loss result is not bound to the persisted worker identity."
            }
        }
        elseif (-not (Test-ProcessObservationEqual $resultWorker $stateWorker)) {
            throw "The immutable supervisor result worker observation changed."
        }
    }
    if (-not (Test-EvidenceReferenceEqual $resultOwnership $stateOwnership)) {
        throw "The immutable supervisor result worker ownership changed."
    }
    if ($status -eq "completed") {
        if ($null -eq $resultWorker -or $null -eq $resultOwnership) {
            throw "A completed supervisor result requires exact worker ownership and exit evidence."
        }
        $journal = Read-JournalStatus $ManifestInfo $Control -RequireTerminal
        $receipt = Read-PreparationReceiptStatus $ManifestInfo $Control -Required
        $resultJournal = Get-RequiredValue $Result "journal"
        $resultReceipt = Get-RequiredValue $Result "fixturePreparationReceipt"
        if ([string](Get-Value $resultJournal "sha256" "") -cne $journal.sha256 -or
            [string](Get-Value $resultJournal "terminalHash" "") -cne $journal.lastRecordHash -or
            (Get-Value $resultJournal "terminalCommitted" $false) -ne $true -or
            [string](Get-Value $resultReceipt "path" "") -cne $receipt.path -or
            [string](Get-Value $resultReceipt "sha256" "") -cne $receipt.sha256) {
            throw "The completed supervisor result cannot be reconciled with the terminal fixture evidence."
        }
    }
    else {
        $failure = Get-RequiredValue $Result "failure"
        if ([string]::IsNullOrWhiteSpace([string](Get-Value $failure "code" "")) -or
            [string]::IsNullOrWhiteSpace([string](Get-Value $failure "stage" "")) -or
            [string](Get-Value $failure "messageSha256" "") -notmatch '^[0-9a-f]{64}$' -or
            (Get-Value $failure "rawErrorPersisted" $true) -ne $false) {
            throw "The non-success supervisor result failure evidence is invalid."
        }
        $resultJournal = Get-Value $Result "journal" $null
        if (-not $HistoricalJournal -and
            $null -ne $resultJournal -and
            -not [string]::IsNullOrWhiteSpace([string](Get-Value $resultJournal "sha256" ""))) {
            $journal = Read-JournalStatus $ManifestInfo $Control
            if ([string](Get-Value $resultJournal "sha256" "") -cne
                [string](Get-Value $journal "sha256" "")) {
                throw "The non-success supervisor result journal changed."
            }
        }
        $resultReceipt = Get-Value $Result "fixturePreparationReceipt" $null
        if ($null -ne $resultReceipt) {
            $receipt = Read-PreparationReceiptStatus $ManifestInfo $Control -Required
            if ([string](Get-Value $resultReceipt "path" "") -cne $receipt.path -or
                [string](Get-Value $resultReceipt "sha256" "") -cne $receipt.sha256) {
                throw "The non-success supervisor result fixture receipt changed."
            }
        }
    }
    return $status
}

function Assert-ReconcilableRecoveryResult {
    param($ManifestInfo, $Control, $Ticket, $State, $Result)
    $status = [string](Get-RequiredValue $Result "status")
    $resultManifest = Get-RequiredValue $Result "manifest"
    $resultTicket = Get-RequiredValue $Result "ticket"
    $resultAdmission = Get-RequiredValue $Result "recoveryAdmission"
    $resultRecovery = Get-RequiredValue $Result "recovery"
    $resultSupervisor = Get-RequiredValue $Result "supervisor"
    $resultWorker = Get-RequiredValue $resultRecovery "worker"
    $stateSupervisor = Get-RequiredValue $State "supervisor"
    $stateWorker = Get-RequiredValue $State "worker"
    $stateOriginal = Get-RequiredValue $State "originalExecution"
    $resultOriginal = Get-RequiredValue $Result "originalExecution"
    $stateOwnership = Get-RequiredValue $State "workerOwnership"
    $resultOwnership = Get-RequiredValue $resultRecovery "workerOwnership"
    if ([int](Get-Value $Result "schemaVersion" 0) -ne 1 -or
        [string](Get-Value $Result "type" "") -cne "waf800_diagnostic_prep_supervisor_result" -or
        [string](Get-Value $Result "version" "") -cne $script:SupervisorVersion -or
        [string](Get-Value $Result "runId" "") -cne $ManifestInfo.RunId -or
        $status -cne "completed" -or
        (Get-Value $Result "terminalEvidenceCommitted" $false) -ne $true -or
        (Get-Value $Result "trafficStarted" $true) -ne $false -or
        (Get-Value $Result "leaseAcquired" $true) -ne $false -or
        (Get-Value $Result "rawErrorPersisted" $true) -ne $false -or
        [string](Get-Value $resultManifest "path" "") -cne $ManifestInfo.Path -or
        [string](Get-Value $resultManifest "sha256" "") -cne $ManifestInfo.Sha256 -or
        [string](Get-Value $resultTicket "path" "") -cne $Ticket.path -or
        [string](Get-Value $resultTicket "sha256" "") -cne $Ticket.sha256 -or
        [string](Get-Value $resultAdmission "path" "") -cne $Control.RecoveryAdmission -or
        -not (Test-ProcessIdentityEqual $resultSupervisor $stateSupervisor) -or
        -not (Test-ProcessObservationEqual $resultWorker $stateWorker) -or
        -not (Test-EvidenceReferenceEqual $resultOwnership $stateOwnership) -or
        ($resultOriginal | ConvertTo-Json -Depth 60 -Compress) -cne
            ($stateOriginal | ConvertTo-Json -Depth 60 -Compress)) {
        throw "The immutable publication-recovery result cannot be reconciled with its persisted state."
    }
    Assert-PrivateAcl $Control.RecoveryAdmission "publication recovery admission"
    if ([string](Get-Value $resultAdmission "sha256" "") -cne
        (Get-FileSha256 $Control.RecoveryAdmission)) {
        throw "The publication-recovery result admission changed."
    }
    $journal = Read-JournalStatus $ManifestInfo $Control -RequireTerminal
    $receipt = Read-PreparationReceiptStatus $ManifestInfo $Control -Required
    $resultJournal = Get-RequiredValue $Result "journal"
    $resultReceipt = Get-RequiredValue $Result "fixturePreparationReceipt"
    if ([string](Get-Value $resultJournal "sha256" "") -cne $journal.sha256 -or
        [string](Get-Value $resultJournal "terminalHash" "") -cne $journal.lastRecordHash -or
        (Get-Value $resultJournal "terminalCommitted" $false) -ne $true -or
        [string](Get-Value $resultReceipt "path" "") -cne $receipt.path -or
        [string](Get-Value $resultReceipt "sha256" "") -cne $receipt.sha256) {
        throw "The publication-recovery result does not match the terminal fixture evidence."
    }
    $recoveryReceiptReference = Get-RequiredValue $Result "publicationRecoveryReceipt"
    $recoveryReceiptPath = Resolve-ExternalPath `
        ([string](Get-RequiredValue (Get-RequiredValue $ManifestInfo.Value "paths") `
            "publicationRecoveryReceiptPath")) "paths.publicationRecoveryReceiptPath" File
    Assert-PrivateAcl $recoveryReceiptPath "publication recovery receipt"
    if ([string](Get-Value $recoveryReceiptReference "path" "") -cne $recoveryReceiptPath -or
        [string](Get-Value $recoveryReceiptReference "sha256" "") -cne
            (Get-FileSha256 $recoveryReceiptPath)) {
        throw "The publication-recovery result receipt changed."
    }
    return $status
}

function Assert-TerminalStateResultBinding {
    param($ManifestInfo, $Control, $Ticket, $State)
    $status = [string](Get-RequiredValue $State "status")
    if (-not (Test-IsTerminalState $status)) {
        throw "Exact terminal result binding requires a terminal supervisor state."
    }
    $path = [IO.Path]::GetFullPath([string](Get-RequiredValue $State "resultPath"))
    if ($path -notin @($Control.Result, $Control.RecoveryResult) -or
        -not (Test-Path -LiteralPath $path -PathType Leaf)) {
        throw "The terminal supervisor state references a missing or unsupported result."
    }
    Assert-PrivateAcl $path "terminal supervisor result"
    $sha256 = Get-FileSha256 $path
    $boundSha256 = Assert-Sha256 ([string](Get-RequiredValue $State "resultSha256")) `
        "terminal supervisor state result sha256"
    $boundStatus = [string](Get-RequiredValue $State "resultStatus")
    $result = Read-PrivateJson $path
    $resultStatus = [string](Get-RequiredValue $result "status")
    if ($sha256 -cne $boundSha256 -or $resultStatus -cne $boundStatus) {
        throw "The terminal supervisor state result hash or status binding changed."
    }
    if ($path -ceq $Control.RecoveryResult) {
        [void](Assert-ReconcilableRecoveryResult $ManifestInfo $Control $Ticket $State $result)
        if ($status -cne $resultStatus) {
            throw "The terminal publication-recovery state and result status differ."
        }
    }
    elseif ($null -ne (Get-Value $State "originalExecution" $null)) {
        $originalExecution = Get-RequiredValue $State "originalExecution"
        $originalStateReference = Get-RequiredValue $originalExecution "state"
        $originalStatePath = [string](Get-RequiredValue $originalStateReference "path")
        if ($originalStatePath -cne $Control.OriginalState -or
            -not (Test-Path -LiteralPath $originalStatePath -PathType Leaf) -or
            [string](Get-RequiredValue $originalStateReference "sha256") -cne
                (Get-FileSha256 $originalStatePath) -or
            [string](Get-RequiredValue $originalExecution "resultPath") -cne $path -or
            [string](Get-RequiredValue $originalExecution "resultSha256") -cne $sha256 -or
            [string](Get-RequiredValue $originalExecution "status") -cne $resultStatus) {
            throw "The recovery state original result binding changed."
        }
        $frozenState = Read-PrivateJson $originalStatePath
        Assert-StateIdentity $ManifestInfo $Ticket $frozenState
        [void](Assert-ReconcilableInitialResult $ManifestInfo $Control $Ticket $frozenState $result `
            -HistoricalJournal)
    }
    else {
        [void](Assert-ReconcilableInitialResult $ManifestInfo $Control $Ticket $State $result)
        if ($status -cne $resultStatus) {
            throw "The terminal initial state and result status differ."
        }
    }
    return [pscustomobject]@{
        path = $path
        sha256 = $sha256
        status = $resultStatus
        value = $result
    }
}

function Get-ProcessLossJournalEvidence {
    param($ManifestInfo, $Control, $Journal, $Receipt)
    if ($Journal.hasPartialRecord -or -not $Journal.exists -or
        [string]::IsNullOrWhiteSpace([string]$Journal.sha256)) {
        throw "Process-loss reconciliation requires a complete committed preparation journal."
    }
    $bytes = [IO.File]::ReadAllBytes($Control.Journal)
    $sha = [Convert]::ToHexString(
        [Security.Cryptography.SHA256]::HashData($bytes)
    ).ToLowerInvariant()
    if ($sha -cne [string]$Journal.sha256) {
        throw "The preparation journal changed during process-loss reconciliation."
    }
    $raw = [Text.UTF8Encoding]::new($false, $true).GetString($bytes)
    $records = @($raw -split "`r?`n" | Where-Object { -not [string]::IsNullOrWhiteSpace($_) } |
        ForEach-Object { $_ | ConvertFrom-Json -DateKind String -Depth 60 -ErrorAction Stop })
    $receiptSealRecords = @($records | Where-Object {
        [string](Get-Value $_ "stage" "") -ceq "fixture_receipt_sealed" -and
        [string](Get-Value $_ "status" "") -ceq "completed"
    })
    if ($receiptSealRecords.Count -ne 1 -or
        [string](Get-Value (Get-RequiredValue $receiptSealRecords[0] "artifactHashes") `
            "fixturePreparationReceiptSha256" "") -cne $Receipt.sha256) {
        throw "Process-loss reconciliation requires the unique sealed fixture receipt record."
    }
    return $records
}

function Assert-NoPreparationDownstreamMarkers {
    param($ManifestInfo)
    $paths = Get-RequiredValue $ManifestInfo.Value "paths"
    foreach ($field in @("leaseReceiptPath", "startGatePath", "trafficMarkerPath")) {
        if (Test-Path -LiteralPath ([string](Get-RequiredValue $paths $field))) {
            throw "Process-loss reconciliation is blocked by a downstream marker."
        }
    }
    foreach ($field in @("bindingRoot", "evidenceDirectory")) {
        if (Test-Path -LiteralPath ([string](Get-RequiredValue $paths $field))) {
            throw "Process-loss reconciliation is blocked by downstream artifacts."
        }
    }
}

function Invoke-ProcessLossReconciliation {
    param($ManifestInfo, $Control, $Ticket, $State)
    $stateStatus = [string](Get-RequiredValue $State "status")
    if ((Test-IsTerminalState $stateStatus) -or $stateStatus -eq "worker_exited") {
        return [pscustomobject]@{ reconciled = $false; state = $State; result = $null }
    }
    $ticketSupervisor = Get-RequiredValue $Ticket.value "supervisor"
    $stateWorker = Get-Value $State "worker" $null
    if ((Test-BoundProcessPresent $ticketSupervisor) -or
        ($null -ne $stateWorker -and (Test-BoundProcessPresent $stateWorker))) {
        return [pscustomobject]@{ reconciled = $false; state = $State; result = $null }
    }
    if (-not (Test-Path -LiteralPath $Control.WorkerOwnership -PathType Leaf)) {
        throw "Process-loss reconciliation requires immutable worker-tree ownership evidence."
    }
    Assert-PrivateAcl $Control.WorkerOwnership "worker ownership evidence"
    $ownershipSha256 = Get-FileSha256 $Control.WorkerOwnership
    $ownership = Read-PrivateJson $Control.WorkerOwnership
    Assert-PreparationExactKeys $ownership @(
        "schemaVersion","type","version","runId","createdAtUtc","manifestSha256",
        "supervisorAdmissionSha256","supervisor","worker","jobPolicy","descendantPolicy"
    ) "worker ownership evidence"
    $ownedSupervisor = Get-RequiredValue $ownership "supervisor"
    $ownedWorker = Get-RequiredValue $ownership "worker"
    if ([int](Get-Value $ownership "schemaVersion" 0) -ne 1 -or
        [string](Get-Value $ownership "type" "") -cne "diagnostic_prep_worker_ownership" -or
        [string](Get-Value $ownership "version" "") -cne $script:WorkerOwnershipVersion -or
        [string](Get-Value $ownership "runId" "") -cne $ManifestInfo.RunId -or
        [string](Get-Value $ownership "manifestSha256" "") -cne $ManifestInfo.Sha256 -or
        [string](Get-Value $ownership "supervisorAdmissionSha256" "") -cne $Ticket.sha256 -or
        [string](Get-Value $ownership "jobPolicy" "") -cne "kill-on-supervisor-close-v1" -or
        [string](Get-Value $ownership "descendantPolicy" "") -cne "no-breakaway-v1" -or
        [int](Get-Value $ownedSupervisor "pid" 0) -ne [int](Get-Value $ticketSupervisor "pid" 0) -or
        [string](Get-Value $ownedSupervisor "startedAtUtc" "") -cne
            [string](Get-Value $ticketSupervisor "startedAtUtc" "") -or
        -not [string]::Equals([string](Get-Value $ownedSupervisor "path" ""),
            [string](Get-Value $ticketSupervisor "path" ""),
            [StringComparison]::OrdinalIgnoreCase) -or
        (Test-BoundProcessPresent $ownedWorker)) {
        throw "Process-loss reconciliation worker ownership evidence is invalid or still active."
    }
    if ($null -ne $stateWorker -and
        ([int](Get-Value $stateWorker "pid" 0) -ne [int](Get-Value $ownedWorker "pid" 0) -or
         [string](Get-Value $stateWorker "startedAtUtc" "") -cne
            [string](Get-Value $ownedWorker "startedAtUtc" "") -or
         -not [string]::Equals([string](Get-Value $stateWorker "path" ""),
            [string](Get-Value $ownedWorker "path" ""),
            [StringComparison]::OrdinalIgnoreCase))) {
        throw "Process-loss reconciliation worker identity drifted from its ownership evidence."
    }
    Assert-PreparationMutexFree $ManifestInfo.RunId
    Assert-NoPreparationDownstreamMarkers $ManifestInfo
    $journal = Read-JournalStatus $ManifestInfo $Control
    $receipt = Read-PreparationReceiptStatus $ManifestInfo $Control -Required
    [void](Get-ProcessLossJournalEvidence $ManifestInfo $Control $journal $receipt)
    $mutex = $null
    $fileLock = $null
    try {
        $mutex = Enter-NewOwnedMutex (Get-SupervisorMutexName $ManifestInfo.RunId) `
            "Another durable supervisor owns process-loss reconciliation."
        $fileLock = Enter-ExclusiveRunFileLock $ManifestInfo $Ticket $Control
        if ((Test-BoundProcessPresent $ticketSupervisor) -or (Test-BoundProcessPresent $ownedWorker)) {
            throw "A bound process reappeared during process-loss reconciliation."
        }
        $workerObservation = [ordered]@{
            pid = [int](Get-Value $ownedWorker "pid" 0)
            startedAtUtc = [string](Get-Value $ownedWorker "startedAtUtc" "")
            path = [string](Get-Value $ownedWorker "path" "")
            completedAtUtc = [DateTimeOffset]::UtcNow.ToString("o")
            exitCode = $null
            timedOut = $false
            exitPersistedBeforeResultParsing = $false
            processLost = $true
        }
        $failure = New-SanitizedFailure "fixture_preparation_supervisor_process_lost" `
            "fixture_preparation" "The admitted supervisor and its owned worker tree disappeared before exit persistence."
        if (Test-Path -LiteralPath $Control.Result -PathType Leaf) {
            Assert-PrivateAcl $Control.Result "process-loss supervisor result"
            $result = Read-PrivateJson $Control.Result
            $resultWorker = Get-RequiredValue $result "worker"
            $resultJournal = Get-RequiredValue $result "journal"
            $resultFailure = Get-RequiredValue $result "failure"
            if ([int](Get-Value $result "schemaVersion" 0) -ne 1 -or
                [string](Get-Value $result "type" "") -cne "waf800_diagnostic_prep_supervisor_result" -or
                [string](Get-Value $result "version" "") -cne $script:SupervisorVersion -or
                [string](Get-Value $result "runId" "") -cne $ManifestInfo.RunId -or
                [string](Get-Value $result "status" "") -cne "interrupted" -or
                [string](Get-Value $resultFailure "code" "") -cne
                    "fixture_preparation_supervisor_process_lost" -or
                (Get-Value $resultWorker "processLost" $false) -ne $true -or
                $null -ne (Get-Value $resultWorker "exitCode" $null) -or
                [string](Get-Value $resultJournal "sha256" "") -cne $journal.sha256 -or
                [string](Get-Value (Get-RequiredValue $result "fixturePreparationReceipt") `
                    "sha256" "") -cne $receipt.sha256) {
                throw "The committed process-loss result is not reconcilable."
            }
        }
        else {
            $result = [ordered]@{
                schemaVersion=1;type="waf800_diagnostic_prep_supervisor_result";version=$script:SupervisorVersion
                runId=$ManifestInfo.RunId
                manifest=[ordered]@{path=$ManifestInfo.Path;sha256=$ManifestInfo.Sha256}
                ticket=[ordered]@{path=$Ticket.path;sha256=$Ticket.sha256}
                supervisorRunLock=[ordered]@{path=$fileLock.path;sha256=$fileLock.sha256}
                status="interrupted";completedAtUtc=[DateTimeOffset]::UtcNow.ToString("o")
                supervisor=$ticketSupervisor;worker=$workerObservation
                workerOwnership=[ordered]@{path=$Control.WorkerOwnership;sha256=$ownershipSha256}
                journal=$journal
                fixturePreparationReceipt=[ordered]@{path=$receipt.path;sha256=$receipt.sha256}
                failure=$failure;terminalEvidenceCommitted=$true;trafficStarted=$false
                leaseAcquired=$false;rawErrorPersisted=$false
            }
            Write-PrivateJson $Control.Result $result -Immutable
        }
        $resultReference = [ordered]@{
            path=$Control.Result;sha256=Get-FileSha256 $Control.Result;status="interrupted"
        }
        $terminalState = New-SupervisorState $ManifestInfo $Ticket "interrupted" `
            $ticketSupervisor $ownedWorker $workerObservation $journal $resultReference $failure
        $terminalState.workerOwnership = [ordered]@{
            path=$Control.WorkerOwnership;sha256=$ownershipSha256
        }
        Write-PrivateJson $Control.State $terminalState
        return [pscustomobject]@{reconciled=$true;state=$terminalState;result=$result}
    }
    finally {
        if ($null -ne $fileLock) { $fileLock.stream.Dispose() }
        Exit-OwnedMutex $mutex
    }
}

function Invoke-TerminalReconciliation {
    param($ManifestInfo, $Control, $Ticket, $State)
    $stateStatus = [string](Get-RequiredValue $State "status")
    $stateResultPath = [string](Get-Value $State "resultPath" "")
    $resultAlreadyBound = -not [string]::IsNullOrWhiteSpace($stateResultPath)
    $hasRecoveryResult = Test-Path -LiteralPath $Control.RecoveryResult -PathType Leaf
    $stateAlreadyBindsRecoveryResult = $resultAlreadyBound -and
        [IO.Path]::GetFullPath($stateResultPath) -ceq $Control.RecoveryResult
    if (($stateAlreadyBindsRecoveryResult -or -not $hasRecoveryResult) -and
        $resultAlreadyBound -and (Test-IsTerminalState $stateStatus)) {
        $binding = Assert-TerminalStateResultBinding $ManifestInfo $Control $Ticket $State
        return [pscustomobject]@{
            reconciled = $false
            state = $State
            result = $binding.value
            validated = $true
        }
    }
    $hasInitialResult = Test-Path -LiteralPath $Control.Result -PathType Leaf
    $hasInitialCandidate = $hasInitialResult -and
        $null -eq (Get-Value $State "originalExecution" $null)
    $hasCommittedResult = $hasRecoveryResult -or $hasInitialCandidate
    if ($stateStatus -ne "worker_exited" -and -not $hasCommittedResult) {
        return [pscustomobject]@{ reconciled = $false; state = $State; result = $null }
    }
    $ticketSupervisor = Get-RequiredValue $Ticket.value "supervisor"
    $recoveryCandidate = $hasRecoveryResult
    $activeSupervisor = if ($recoveryCandidate) {
        Get-RequiredValue $State "supervisor"
    }
    else { $ticketSupervisor }
    $stateWorker = Get-Value $State "worker" $null
    if ((Test-BoundProcessPresent $activeSupervisor) -or
        ($null -ne $stateWorker -and (Test-BoundProcessPresent $stateWorker))) {
        throw "Terminal reconciliation is blocked while a bound process is present."
    }
    if (-not $hasCommittedResult -and ($null -eq $stateWorker -or
        (Get-Value $stateWorker "exitPersistedBeforeResultParsing" $false) -ne $true)) {
        throw "Terminal reconciliation requires a persisted exact worker exit observation."
    }
    $mutex = $null
    $fileLock = $null
    try {
        $mutex = Enter-NewOwnedMutex (Get-SupervisorMutexName $ManifestInfo.RunId) `
            "Another durable supervisor owns terminal reconciliation."
        $fileLock = Enter-ExclusiveRunFileLock $ManifestInfo $Ticket $Control
        $result = $null
        $resultPath = $null
        if ($hasRecoveryResult) {
            $resultPath = $Control.RecoveryResult
            Assert-PrivateAcl $resultPath "reconcilable publication-recovery result"
            $result = Read-PrivateJson $resultPath
            [void](Assert-ReconcilableRecoveryResult $ManifestInfo $Control $Ticket $State $result)
        }
        elseif ($hasInitialCandidate) {
            $resultPath = $Control.Result
            Assert-PrivateAcl $resultPath "reconcilable supervisor result"
            $result = Read-PrivateJson $resultPath
            [void](Assert-ReconcilableInitialResult $ManifestInfo $Control $Ticket $State $result)
        }
        else {
            $journal = Read-JournalStatus $ManifestInfo $Control
            $timedOut = [bool](Get-Value $stateWorker "timedOut" $false)
            $exitCode = Get-Value $stateWorker "exitCode" $null
            $status = if ($timedOut) { "timed_out" }
            elseif ($null -ne $exitCode -and [int]$exitCode -eq 0) { "completed" }
            elseif ([string](Get-Value $journal "lastStage" "") -ceq "terminal_commit") { "failed" }
            else { "interrupted" }
            if ($status -eq "completed") {
                Assert-PrivateAcl $Control.WorkerStdout "fixture-worker stdout"
                Assert-PrivateAcl $Control.WorkerStderr "fixture-worker stderr"
                if (-not [string]::IsNullOrWhiteSpace(
                        (Get-Content -LiteralPath $Control.WorkerStderr -Raw))) {
                    throw "A successful worker exit with stderr cannot be reconciled."
                }
                try {
                    $workerResult = Get-Content -LiteralPath $Control.WorkerStdout -Raw |
                        ConvertFrom-Json -DateKind String -Depth 60 -ErrorAction Stop
                }
                catch { throw "The successful worker output cannot be reconciled." }
                $journal = Read-JournalStatus $ManifestInfo $Control -RequireTerminal
                $receipt = Read-PreparationReceiptStatus $ManifestInfo $Control -Required
                $verificationHash = Assert-Sha256 `
                    ([string](Get-RequiredValue (Get-RequiredValue $receipt.value "verification") `
                        "countsAndGatesSha256")) "fixture verification counts/gates sha256"
                if ($workerResult -is [Array] -or (Get-Value $workerResult "valid" $false) -ne $true -or
                    [string](Get-Value $workerResult "status" "") -cne "completed" -or
                    [string](Get-Value $workerResult "runId" "") -cne $ManifestInfo.RunId -or
                    [string](Get-Value $workerResult "manifestSha256" "") -cne $ManifestInfo.Sha256 -or
                    [string](Get-Value $workerResult "journalTerminalHash" "") -cne $journal.lastRecordHash -or
                    [string](Get-Value $workerResult "fixturePreparationReceiptSha256" "") -cne $receipt.sha256 -or
                    [string](Get-Value $workerResult "supervisorAdmissionSha256" "") -cne $Ticket.sha256 -or
                    [string](Get-Value $workerResult "verificationCountsAndGatesSha256" "") -cne $verificationHash) {
                    throw "The successful worker completion is not bound to the sealed terminal evidence."
                }
                $result = [ordered]@{
                    schemaVersion=1;type="waf800_diagnostic_prep_supervisor_result";version=$script:SupervisorVersion
                    runId=$ManifestInfo.RunId
                    manifest=[ordered]@{path=$ManifestInfo.Path;sha256=$ManifestInfo.Sha256}
                    ticket=[ordered]@{path=$Ticket.path;sha256=$Ticket.sha256}
                    supervisorRunLock=[ordered]@{path=$fileLock.path;sha256=$fileLock.sha256}
                    supervisorAdmissionSha256=$Ticket.sha256
                    verificationCountsAndGatesSha256=$verificationHash
                    status="completed";completedAtUtc=[DateTimeOffset]::UtcNow.ToString("o")
                    supervisor=$ticketSupervisor;worker=$stateWorker
                    workerOwnership=Get-RequiredValue $State "workerOwnership"
                    journal=[ordered]@{path=$Control.Journal;sha256=$journal.sha256;recordCount=$journal.recordCount;terminalHash=$journal.lastRecordHash;terminalCommitted=$true}
                    fixturePreparationReceipt=[ordered]@{path=$receipt.path;sha256=$receipt.sha256}
                    workerResultSha256=Get-TextSha256 ($workerResult | ConvertTo-Json -Depth 60 -Compress)
                    terminalEvidenceCommitted=$true;trafficStarted=$false;leaseAcquired=$false;rawErrorPersisted=$false
                }
            }
            else {
                $failureCode = if ($status -eq "timed_out") { "fixture_preparation_worker_timeout" }
                elseif ($status -eq "interrupted") { "fixture_preparation_worker_interrupted" }
                else { "fixture_preparation_supervisor_failed" }
                $failure = New-SanitizedFailure $failureCode "fixture_preparation" `
                    "Terminal reconciliation sealed a previously persisted non-success worker exit."
                $result = [ordered]@{
                    schemaVersion=1;type="waf800_diagnostic_prep_supervisor_result";version=$script:SupervisorVersion
                    runId=$ManifestInfo.RunId
                    manifest=[ordered]@{path=$ManifestInfo.Path;sha256=$ManifestInfo.Sha256}
                    ticket=[ordered]@{path=$Ticket.path;sha256=$Ticket.sha256}
                    supervisorRunLock=[ordered]@{path=$fileLock.path;sha256=$fileLock.sha256}
                    status=$status;completedAtUtc=[DateTimeOffset]::UtcNow.ToString("o")
                    supervisor=$ticketSupervisor;worker=$stateWorker
                    workerOwnership=Get-RequiredValue $State "workerOwnership"
                    journal=$journal;failure=$failure
                    terminalEvidenceCommitted=$true;trafficStarted=$false;leaseAcquired=$false;rawErrorPersisted=$false
                }
            }
            Write-PrivateJson $Control.Result $result -Immutable
            $resultPath = $Control.Result
        }
        $resultSha = Get-FileSha256 $resultPath
        $terminalStatus = [string](Get-RequiredValue $result "status")
        if ($resultPath -ceq $Control.RecoveryResult) {
            $recovery = Get-RequiredValue $result "recovery"
            $adoptedWorker = Get-RequiredValue $recovery "worker"
            $terminalState = New-SupervisorState $ManifestInfo $Ticket $terminalStatus `
                (Get-RequiredValue $result "supervisor") $adoptedWorker $adoptedWorker `
                (Get-Value $result "journal" $null) `
                ([ordered]@{path=$resultPath;sha256=$resultSha;status=$terminalStatus}) `
                (Get-Value $result "failure" $null)
            $terminalState.originalExecution = Get-RequiredValue $result "originalExecution"
            $terminalState.workerOwnership = Get-RequiredValue $recovery "workerOwnership"
            $terminalState.recoveryAdmission = Get-RequiredValue $result "recoveryAdmission"
        }
        else {
            $adoptedWorker = Get-Value $result "worker" $null
            $terminalState = New-SupervisorState $ManifestInfo $Ticket $terminalStatus $ticketSupervisor `
                $adoptedWorker $adoptedWorker (Get-Value $result "journal" $null) `
                ([ordered]@{path=$resultPath;sha256=$resultSha;status=$terminalStatus}) `
                (Get-Value $result "failure" $null)
            $terminalState.workerOwnership = Get-Value $result "workerOwnership" $null
        }
        Write-PrivateJson $Control.State $terminalState
        return [pscustomobject]@{ reconciled = $true; state = $terminalState; result = $result }
    }
    finally {
        if ($null -ne $fileLock) { $fileLock.stream.Dispose() }
        Exit-OwnedMutex $mutex
    }
}

function Invoke-StatusMode {
    param($ManifestInfo, $Control)
    $script:FailureDetailStage = "status_launch_evidence"
    if (-not (Test-Path -LiteralPath $Control.Ticket -PathType Leaf)) {
        if (-not (Test-Path -LiteralPath $Control.LaunchAdmission -PathType Leaf)) {
            throw "The preparation run has neither an immutable launch admission nor a child-authored ticket."
        }
        Assert-PrivateAcl $Control.LaunchAdmission "supervisor launch admission"
        $admission = Read-PrivateJson $Control.LaunchAdmission
        if ([int](Get-Value $admission "schemaVersion" 0) -ne 1 -or
            [string](Get-Value $admission "type" "") -cne "diagnostic_prep_supervisor_launch_admission" -or
            [string](Get-Value $admission "version" "") -cne $script:LaunchAdmissionVersion -or
            [string](Get-Value $admission "runId" "") -cne $ManifestInfo.RunId -or
            [string](Get-Value (Get-RequiredValue $admission "manifest") "sha256" "") -cne
                $ManifestInfo.Sha256) {
            throw "The admitted launch evidence is invalid."
        }
        $launchPresence = Read-LaunchPresence $ManifestInfo $Control
        $presenceSupervisor = if ($null -eq $launchPresence) {
            $null
        } else { Get-RequiredValue $launchPresence.value "supervisor" }
        $presenceProcessPresent = $null -ne $presenceSupervisor -and
            (Test-BoundProcessPresent $presenceSupervisor)
        return [ordered]@{
            schemaVersion = 1; type = "diagnostic_prep_supervisor_status"; version = $script:SupervisorVersion
            runId = $ManifestInfo.RunId
            status = if ($null -eq $launchPresence) { "launch_admitted" } else { "launching" }
            healthy = $presenceProcessPresent
            launchAdmission = [ordered]@{
                path = $Control.LaunchAdmission
                sha256 = Get-FileSha256 $Control.LaunchAdmission
            }
            launchPresence = if ($null -eq $launchPresence) { $null } else {
                [ordered]@{ path = $launchPresence.path; sha256 = $launchPresence.sha256 }
            }
            ticket = $null; supervisorProcessPresent = $presenceProcessPresent; workerProcessPresent = $false
            journal = Read-JournalStatus $ManifestInfo $Control; result = $null
            finding = if ($null -eq $launchPresence) { "launch_admitted_no_presence" }
                elseif ($presenceProcessPresent) { $null }
                else { "supervisor_process_lost_before_ticket" }
            trafficStarted = $false; leaseAcquired = $false
        }
    }
    $ticket = Read-Ticket $ManifestInfo $Control
    $recoveryAdmissionStatus = Read-RecoveryAdmissionStatus $ManifestInfo $Control $ticket
    $script:FailureDetailStage = "status_process_evidence"
    $ticketSupervisor = Get-RequiredValue $ticket.value "supervisor"
    $supervisorPresent = Test-BoundProcessPresent $ticketSupervisor
    if (-not (Test-Path -LiteralPath $Control.State -PathType Leaf)) {
        $journal = Read-JournalStatus $ManifestInfo $Control
        if ($journal.hasPartialRecord -and -not $supervisorPresent) {
            throw "The preparation journal ends with an uncommitted partial record."
        }
        return [ordered]@{
            schemaVersion = 1; type = "diagnostic_prep_supervisor_status"; version = $script:SupervisorVersion
            runId = $ManifestInfo.RunId; status = "launching"; healthy = $supervisorPresent
            ticket = [ordered]@{ path = $ticket.path; sha256 = $ticket.sha256 }
            supervisorProcessPresent = $supervisorPresent; workerProcessPresent = $false
            journal = $journal
            result = $null
            finding = if ($supervisorPresent) { $null } else { "supervisor_process_lost_before_state" }
            trafficStarted = $false; leaseAcquired = $false
        }
    }
    $state = Read-PrivateJson $Control.State
    $script:FailureDetailStage = "status_state_evidence"
    Assert-StateIdentity $ManifestInfo $ticket $state
    $status = [string](Get-RequiredValue $state "status")
    $hasRecoveryResult = Test-Path -LiteralPath $Control.RecoveryResult -PathType Leaf
    $resultPathFromState = [string](Get-Value $state "resultPath" "")
    $stateRecoveryAdmission = Get-Value $state "recoveryAdmission" $null
    $recoveryResultAwaitingState = $hasRecoveryResult -and
        ([string]::IsNullOrWhiteSpace($resultPathFromState) -or
            [IO.Path]::GetFullPath($resultPathFromState) -cne $Control.RecoveryResult)
    $recoveryAdmissionPendingState = $null -ne $recoveryAdmissionStatus -and
        $null -eq $stateRecoveryAdmission
    $activeSupervisorIdentity = if ($recoveryAdmissionPendingState -or
        $recoveryResultAwaitingState) {
        Get-RequiredValue $recoveryAdmissionStatus.value "supervisor"
    }
    elseif ($status.StartsWith("recovery_", [StringComparison]::Ordinal) -or
        $null -ne $stateRecoveryAdmission) {
        Get-RequiredValue $state "supervisor"
    }
    else { $ticketSupervisor }
    $supervisorPresent = Test-BoundProcessPresent $activeSupervisorIdentity
    $workerIdentity = Get-Value $state "worker" $null
    $workerPresent = Test-BoundProcessPresent $workerIdentity
    $script:FailureDetailStage = "status_journal_evidence"
    $journal = Read-JournalStatus $ManifestInfo $Control
    $terminal = Test-IsTerminalState $status
    if ($journal.hasPartialRecord -and ($terminal -or (-not $supervisorPresent -and -not $workerPresent))) {
        throw "The preparation journal ends with an uncommitted partial record."
    }
    $resultStatus = $null
    $resultRef = $null
    $committedResultAwaitingState = $false
    if ($recoveryResultAwaitingState) {
        $script:FailureDetailStage = "status_recovery_result_evidence"
        Assert-PrivateAcl $Control.RecoveryResult "publication-recovery result awaiting state reconciliation"
        $result = Read-PrivateJson $Control.RecoveryResult
        [void](Assert-ReconcilableRecoveryResult $ManifestInfo $Control $ticket $state $result)
        $resultStatus = [string](Get-RequiredValue $result "status")
        $resultRef = [ordered]@{
            path = $Control.RecoveryResult
            sha256 = Get-FileSha256 $Control.RecoveryResult
            status = $resultStatus
        }
        $committedResultAwaitingState = $true
    }
    elseif (-not [string]::IsNullOrWhiteSpace($resultPathFromState)) {
        $script:FailureDetailStage = "status_result_evidence"
        if ($terminal) {
            $binding = Assert-TerminalStateResultBinding $ManifestInfo $Control $ticket $state
            $result = $binding.value
            $resultStatus = $binding.status
            $resultRef = [ordered]@{
                path = $binding.path
                sha256 = $binding.sha256
                status = $binding.status
            }
        }
        else {
            $resultPath = [IO.Path]::GetFullPath($resultPathFromState)
            if ($resultPath -notin @($Control.Result, $Control.RecoveryResult) -or
                -not (Test-Path -LiteralPath $resultPath -PathType Leaf)) {
                throw "The supervisor result reference is missing or changed."
            }
            $resultSha = Get-FileSha256 $resultPath
            $result = Read-PrivateJson $resultPath
            if ([string](Get-Value $result "runId" "") -cne $ManifestInfo.RunId -or
                [string](Get-Value (Get-RequiredValue $result "manifest") "sha256" "") -cne $ManifestInfo.Sha256 -or
                [string](Get-Value (Get-RequiredValue $result "ticket") "sha256" "") -cne $ticket.sha256) {
                throw "The supervisor result identity is invalid."
            }
            $resultStatus = [string](Get-Value $result "status" "")
            $boundResultSha = Assert-Sha256 ([string](Get-RequiredValue $state "resultSha256")) `
                "supervisor state result sha256"
            $boundResultStatus = [string](Get-RequiredValue $state "resultStatus")
            if ($boundResultSha -cne $resultSha -or $boundResultStatus -cne $resultStatus) {
                throw "The supervisor state result hash or status binding changed."
            }
            $resultRef = [ordered]@{ path = $resultPath; sha256 = $resultSha; status = $resultStatus }
        }
    }
    elseif (Test-Path -LiteralPath $Control.Result -PathType Leaf) {
        Assert-PrivateAcl $Control.Result "supervisor result awaiting state reconciliation"
        $result = Read-PrivateJson $Control.Result
        [void](Assert-ReconcilableInitialResult $ManifestInfo $Control $ticket $state $result)
        $resultStatus = [string](Get-RequiredValue $result "status")
        $resultRef = [ordered]@{
            path = $Control.Result
            sha256 = Get-FileSha256 $Control.Result
            status = $resultStatus
        }
        $committedResultAwaitingState = $true
    }
    $finding = $null
    if ($committedResultAwaitingState) {
        $finding = if ($recoveryResultAwaitingState -and $supervisorPresent) {
            $null
        }
        elseif ($recoveryResultAwaitingState) {
            "recovery_terminal_result_committed_state_reconciliation_required"
        }
        elseif ($supervisorPresent) { $null }
        else { "terminal_result_committed_state_reconciliation_required" }
    }
    elseif (($recoveryAdmissionPendingState -or $status -ceq "recovery_admitted") -and
        -not $supervisorPresent) {
        $finding = "recovery_admitted_incomplete"
    }
    elseif ($status -eq "worker_exited" -and -not $supervisorPresent -and -not $workerPresent) {
        $finding = "terminal_reconciliation_required"
    }
    elseif (-not $terminal -and -not $supervisorPresent) {
        $finding = if ($workerPresent) {
            "supervisor_process_lost_with_orphan_worker"
        } else { "supervisor_process_lost_without_terminal_state" }
    }
    elseif ($terminal -and $null -eq $resultRef) {
        $finding = "terminal_state_missing_result"
    }
    elseif ($terminal -and $resultStatus -cne $status) {
        $finding = "terminal_state_result_status_mismatch"
    }
    elseif ($status -eq "completed" -and (-not $journal.terminalCommitted -or $resultStatus -ne "completed")) {
        $finding = "completed_state_evidence_mismatch"
    }
    return [ordered]@{
        schemaVersion = 1
        type = "diagnostic_prep_supervisor_status"
        version = $script:SupervisorVersion
        runId = $ManifestInfo.RunId
        status = if ($recoveryResultAwaitingState -and $supervisorPresent) {
            "recovery_committing"
        }
        elseif ($committedResultAwaitingState -and $supervisorPresent) {
            "committing"
        }
        elseif ($recoveryAdmissionPendingState) { "recovery_admitted" }
        else { $status }
        healthy = [string]::IsNullOrWhiteSpace($finding)
        ticket = [ordered]@{ path = $ticket.path; sha256 = $ticket.sha256 }
        supervisorProcessPresent = $supervisorPresent
        workerProcessPresent = $workerPresent
        lastKnownStage = $journal.lastStage
        journal = $journal
        result = $resultRef
        recoveryAdmission = if ($null -eq $recoveryAdmissionStatus) { $null } else {
            [ordered]@{
                path = $recoveryAdmissionStatus.path
                sha256 = $recoveryAdmissionStatus.sha256
            }
        }
        finding = $finding
        trafficStarted = $false
        leaseAcquired = $false
    }
}

function Invoke-ResumePublicationMode {
    param($ManifestInfo, $Control)
    $ticket = Read-Ticket $ManifestInfo $Control
    $ticketSupervisor = Get-RequiredValue $ticket.value "supervisor"
    if (-not (Test-Path -LiteralPath $Control.State -PathType Leaf)) {
        throw "Publication recovery requires the original supervisor state."
    }
    $originalState = Read-PrivateJson $Control.State
    Assert-StateIdentity $ManifestInfo $ticket $originalState
    $reconciliation = Invoke-TerminalReconciliation $ManifestInfo $Control $ticket $originalState
    if ($reconciliation.reconciled) {
        $originalState = $reconciliation.state
        if ([string](Get-RequiredValue $originalState "status") -ceq "completed") {
            return $reconciliation.result
        }
    }
    $processLossReconciliation = Invoke-ProcessLossReconciliation `
        $ManifestInfo $Control $ticket $originalState
    if ($processLossReconciliation.reconciled) {
        $originalState = $processLossReconciliation.state
    }
    $originalStatus = [string](Get-RequiredValue $originalState "status")
    if (-not (Test-IsTerminalState $originalStatus)) {
        throw "Publication recovery requires a terminal original execution."
    }
    if ($originalStatus -eq "completed") {
        throw "The original preparation already completed; recovery is not permitted."
    }
    $originalSupervisor = Get-Value $originalState "supervisor" $null
    $originalWorker = Get-Value $originalState "worker" $null
    if ((Test-BoundProcessPresent $originalSupervisor) -or (Test-BoundProcessPresent $originalWorker)) {
        throw "Publication recovery is blocked while an original bound process is present."
    }
    Assert-PreparationMutexFree $ManifestInfo.RunId
    Assert-NamedMutexFree (Get-SupervisorMutexName $ManifestInfo.RunId) `
        "The original durable supervisor still owns the supervisor mutex."
    Assert-ExclusiveRunFileLockFree $ManifestInfo $ticket $Control
    $sealedReceipt = Read-PreparationReceiptStatus $ManifestInfo $Control -Required
    $originalResultPath = [string](Get-Value $originalState "resultPath" "")
    if ([string]::IsNullOrWhiteSpace($originalResultPath) -or
        [IO.Path]::GetFullPath($originalResultPath) -cne $Control.Result -or
        -not (Test-Path -LiteralPath $Control.Result -PathType Leaf)) {
        throw "Publication recovery requires the intact original terminal result."
    }
    Assert-PrivateAcl $Control.Result "original supervisor result"
    $originalResultSha256 = Get-FileSha256 $Control.Result
    $originalResult = Read-PrivateJson $Control.Result
    $originalResultManifest = Get-RequiredValue $originalResult "manifest"
    $originalResultTicket = Get-RequiredValue $originalResult "ticket"
    if ([int](Get-Value $originalResult "schemaVersion" 0) -ne 1 -or
        [string](Get-Value $originalResult "type" "") -cne "waf800_diagnostic_prep_supervisor_result" -or
        [string](Get-Value $originalResult "version" "") -cne $script:SupervisorVersion -or
        [string](Get-Value $originalResult "runId" "") -cne $ManifestInfo.RunId -or
        [string](Get-Value $originalResult "status" "") -cne $originalStatus -or
        (Get-Value $originalResult "terminalEvidenceCommitted" $false) -ne $true -or
        (Get-Value $originalResult "trafficStarted" $true) -ne $false -or
        (Get-Value $originalResult "leaseAcquired" $true) -ne $false -or
        (Get-Value $originalResult "rawErrorPersisted" $true) -ne $false -or
        [string](Get-Value $originalResultManifest "path" "") -cne $ManifestInfo.Path -or
        [string](Get-Value $originalResultManifest "sha256" "") -cne $ManifestInfo.Sha256 -or
        [string](Get-Value $originalResultTicket "path" "") -cne $ticket.path -or
        [string](Get-Value $originalResultTicket "sha256" "") -cne $ticket.sha256) {
        throw "Publication recovery requires an intact, coherent original terminal result."
    }
    $originalResultWorker = Get-Value $originalResult "worker" $null
    $originalResultSupervisor = Get-RequiredValue $originalResult "supervisor"
    if ([int](Get-Value $originalResultSupervisor "pid" 0) -ne
            [int](Get-Value $ticketSupervisor "pid" 0) -or
        [string](Get-Value $originalResultSupervisor "startedAtUtc" "") -cne
            [string](Get-Value $ticketSupervisor "startedAtUtc" "") -or
        -not [string]::Equals(
            [string](Get-Value $originalResultSupervisor "path" ""),
            [string](Get-Value $ticketSupervisor "path" ""),
            [StringComparison]::OrdinalIgnoreCase)) {
        throw "Publication recovery original supervisor evidence drifted from its ticket."
    }
    $originalWorkerExitCode = Get-Value $originalWorker "exitCode" $null
    $originalResultWorkerExitCode = Get-Value $originalResultWorker "exitCode" $null
    $workerExitCodesMatch = if ($null -eq $originalWorkerExitCode -or
        $null -eq $originalResultWorkerExitCode) {
        $null -eq $originalWorkerExitCode -and $null -eq $originalResultWorkerExitCode
    }
    else { [int]$originalWorkerExitCode -eq [int]$originalResultWorkerExitCode }
    if ($null -eq $originalWorker -or $null -eq $originalResultWorker -or
        [int](Get-Value $originalWorker "pid" 0) -ne [int](Get-Value $originalResultWorker "pid" 0) -or
        [string](Get-Value $originalWorker "startedAtUtc" "") -cne
            [string](Get-Value $originalResultWorker "startedAtUtc" "") -or
        -not [string]::Equals(
            [string](Get-Value $originalWorker "path" ""),
            [string](Get-Value $originalResultWorker "path" ""),
            [StringComparison]::OrdinalIgnoreCase) -or
        -not $workerExitCodesMatch) {
        throw "Publication recovery original worker evidence drifted from its terminal state."
    }
    # Deterministic run-consumption blockers are checked before the immutable
    # recovery admission is created.  A downstream run or stale one-use marker
    # must never burn the sole filesystem-only publication recovery attempt.
    Assert-NoPreparationDownstreamMarkers $ManifestInfo
    if (Test-Path -LiteralPath $Control.PublicationRecoveryReceipt) {
        throw "The one permitted publication recovery receipt already exists."
    }
    if ((Test-Path -LiteralPath $Control.RecoveryStdout) -or
        (Test-Path -LiteralPath $Control.RecoveryStderr) -or
        (Test-Path -LiteralPath $Control.RecoveryResult) -or
        (Test-Path -LiteralPath $Control.RecoveryAdmission) -or
        (Test-Path -LiteralPath $Control.OriginalState) -or
        (Test-Path -LiteralPath $Control.RecoveryWorkerOwnership)) {
        throw "The one permitted publication recovery has already been attempted."
    }
    $process = $null
    $boundRecoveryLaunch = $null
    $recoveryJob = [IntPtr]::Zero
    $recoveryOwnershipRef = $null
    $recoveryIdentity = $null
    $observation = $null
    $recoverySupervisorMutex = $null
    $recoveryFileLock = $null
    $recoveryAdmissionRef = $null
    $currentSupervisor = Get-ProcessIdentity (Get-Process -Id $PID)
    $originalExecution = $null
    $originalStateRef = $null
    try {
        $recoverySupervisorMutex = Enter-NewOwnedMutex (Get-SupervisorMutexName $ManifestInfo.RunId) `
            "Another durable supervisor already owns this preparation run."
        $recoveryFileLock = Enter-ExclusiveRunFileLock $ManifestInfo $ticket $Control
        # Precompute the exact frozen-state bytes and hash without writing any
        # recovery artifact.  The immutable admission below is deliberately
        # the first recovery-attempt artifact and binds these prospective
        # bytes; a crash after admission consumes the one allowed attempt,
        # while a crash before admission leaves no ambiguous attempt residue.
        $originalStateBytes = Get-PrivateJsonBytes $originalState
        $originalStateRef = [ordered]@{
            path = $Control.OriginalState
            sha256 = Get-BytesSha256 $originalStateBytes
        }

        $originalExecution = [ordered]@{
            status = $originalStatus
            supervisor = $originalSupervisor
            worker = $originalWorker
            workerObservation = Get-Value $originalState "workerObservation" $null
            workerOwnership = Get-RequiredValue $originalState "workerOwnership"
            resultPath = $Control.Result
            resultSha256 = $originalResultSha256
            state = $originalStateRef
            failureCode = Get-Value $originalState "failureCode" $null
        }
        $originalResultReference = [ordered]@{
            path = $Control.Result
            sha256 = $originalResultSha256
            status = $originalStatus
        }
        $recoveryNonce = [Guid]::NewGuid().ToString("N")
        $recoveryAdmission = [ordered]@{
            schemaVersion = 1
            type = "diagnostic_prep_publication_recovery_admission"
            version = $script:RecoveryAdmissionVersion
            mode = "ResumePublication"
            runId = $ManifestInfo.RunId
            createdAtUtc = [DateTimeOffset]::UtcNow.ToString("o")
            manifest = [ordered]@{ path = $ManifestInfo.Path; sha256 = $ManifestInfo.Sha256 }
            worker = [ordered]@{ path = $ManifestInfo.Worker.path; sha256 = $ManifestInfo.Worker.sha256 }
            supervisorScript = [ordered]@{ path = $script:SelfPath; sha256 = Get-FileSha256 $script:SelfPath }
            supervisor = $currentSupervisor
            originalTicket = [ordered]@{ path = $ticket.path; sha256 = $ticket.sha256 }
            originalExecution = [ordered]@{
                statePath = $originalStateRef.path
                stateSha256 = $originalStateRef.sha256
                resultPath = $Control.Result
                resultSha256 = $originalResultSha256
                fixturePreparationReceiptPath = $sealedReceipt.path
                fixturePreparationReceiptSha256 = $sealedReceipt.sha256
            }
            recoveryNonceSha256 = Get-TextSha256 $recoveryNonce
            control = [ordered]@{
                statePath = $Control.State
                recoveryResultPath = $Control.RecoveryResult
                recoveryStdoutPath = $Control.RecoveryStdout
                recoveryStderrPath = $Control.RecoveryStderr
                runMutexName = Get-PreparationMutexName $ManifestInfo.RunId
                supervisorMutexName = Get-SupervisorMutexName $ManifestInfo.RunId
                supervisorLockPath = $Control.SupervisorLock
            }
        }
        Write-PrivateJson $Control.RecoveryAdmission $recoveryAdmission -Immutable
        $recoveryAdmissionRef = [ordered]@{
            path = $Control.RecoveryAdmission
            sha256 = Get-FileSha256 $Control.RecoveryAdmission
        }
        $afterRecoveryAdmissionDelay = Get-OfflineTestDelayMilliseconds $ManifestInfo `
            "supervisorAfterRecoveryAdmissionDelayMilliseconds"
        if ($afterRecoveryAdmissionDelay -gt 0) {
            Start-Sleep -Milliseconds $afterRecoveryAdmissionDelay
        }
        Write-PrivateBytes $Control.OriginalState $originalStateBytes -Immutable
        if ((Get-FileSha256 $Control.OriginalState) -cne $originalStateRef.sha256) {
            throw "The frozen original supervisor state differs from its admitted bytes."
        }
        New-PrivateEmptyFile $Control.RecoveryStdout
        New-PrivateEmptyFile $Control.RecoveryStderr
        $recoveryState = New-SupervisorState $ManifestInfo $ticket "recovery_admitted" `
            $currentSupervisor $null $null $null `
            $originalResultReference $null
        $recoveryState.originalExecution = $originalExecution
        $recoveryState.recoveryAdmission = $recoveryAdmissionRef
        Write-PrivateJson $Control.State $recoveryState
        $pwsh = Get-PwshPath
        $arguments = @(
            "-NoProfile", "-File", (Quote-ProcessArgument $ManifestInfo.Worker.path),
            "-Mode", "ResumePublication",
            "-ManifestPath", (Quote-ProcessArgument $ManifestInfo.Path),
            "-ExpectedManifestSha256", $ManifestInfo.Sha256,
            "-SupervisorAdmissionPath", (Quote-ProcessArgument $recoveryAdmissionRef.path),
            "-ExpectedSupervisorAdmissionSha256", $recoveryAdmissionRef.sha256,
            "-SupervisorAdmissionNonce", $recoveryNonce
        )
        $recoveryJob = New-DiagnosticPrepKillOnCloseJob
        $boundRecoveryLaunch = Start-DiagnosticPrepSuspendedJobProcess `
            -ExecutablePath $pwsh -Arguments $arguments `
            -StandardOutputPath $Control.RecoveryStdout `
            -StandardErrorPath $Control.RecoveryStderr -JobHandle $recoveryJob
        $process = $boundRecoveryLaunch.Process
        $recoveryIdentity = $boundRecoveryLaunch.Identity
        $recoveryOwnership = [ordered]@{
            schemaVersion = 1
            type = "diagnostic_prep_worker_ownership"
            version = $script:WorkerOwnershipVersion
            runId = $ManifestInfo.RunId
            createdAtUtc = [DateTimeOffset]::UtcNow.ToString("o")
            manifestSha256 = $ManifestInfo.Sha256
            supervisorAdmissionSha256 = $recoveryAdmissionRef.sha256
            supervisor = $currentSupervisor
            worker = $recoveryIdentity
            jobPolicy = "kill-on-supervisor-close-v1"
            descendantPolicy = "no-breakaway-v1"
        }
        Write-PrivateJson $Control.RecoveryWorkerOwnership $recoveryOwnership -Immutable
        $recoveryOwnershipRef = [ordered]@{
            path = $Control.RecoveryWorkerOwnership
            sha256 = Get-FileSha256 $Control.RecoveryWorkerOwnership
        }
        $afterRecoveryWorkerAssignmentDelay = Get-OfflineTestDelayMilliseconds $ManifestInfo `
            "supervisorAfterRecoveryWorkerAssignmentBeforeResumeDelayMilliseconds"
        if ($afterRecoveryWorkerAssignmentDelay -gt 0) {
            Start-Sleep -Milliseconds $afterRecoveryWorkerAssignmentDelay
        }
        $running = New-SupervisorState $ManifestInfo $ticket "recovery_running" `
            $currentSupervisor $recoveryIdentity $null $null `
            $originalResultReference $null
        $running.originalExecution = $originalExecution
        $running.workerOwnership = $recoveryOwnershipRef
        $running.recoveryAdmission = $recoveryAdmissionRef
        Resume-DiagnosticPrepJobProcess $boundRecoveryLaunch
        Write-PrivateJson $Control.State $running
        if (-not $process.WaitForExit(600000)) {
            Close-DiagnosticPrepJob $recoveryJob
            $recoveryJob = [IntPtr]::Zero
            if (-not $process.WaitForExit(10000)) { Stop-BoundProcess $process }
            throw [TimeoutException]::new("Publication recovery exceeded its filesystem-only timeout.")
        }
        $process.WaitForExit()
        $observation = [ordered]@{
            pid = $recoveryIdentity.pid; startedAtUtc = $recoveryIdentity.startedAtUtc; path = $recoveryIdentity.path
            completedAtUtc = [DateTimeOffset]::UtcNow.ToString("o"); exitCode = $process.ExitCode
            timedOut = $false; exitPersistedBeforeResultParsing = $true
        }
        $exited = New-SupervisorState $ManifestInfo $ticket "recovery_worker_exited" `
            $currentSupervisor $recoveryIdentity $observation $null `
            $originalResultReference $null
        $exited.originalExecution = $originalExecution
        $exited.workerOwnership = $recoveryOwnershipRef
        $exited.recoveryAdmission = $recoveryAdmissionRef
        Write-PrivateJson $Control.State $exited
        Assert-PrivateAcl $Control.RecoveryStdout "publication-recovery stdout"
        Assert-PrivateAcl $Control.RecoveryStderr "publication-recovery stderr"
        if ($process.ExitCode -ne 0) { throw "The publication recovery worker exited nonzero." }
        $stderr = Get-Content -LiteralPath $Control.RecoveryStderr -Raw
        if (-not [string]::IsNullOrWhiteSpace($stderr)) { throw "The publication recovery worker emitted stderr." }
        try {
            $workerResult = Get-Content -LiteralPath $Control.RecoveryStdout -Raw |
                ConvertFrom-Json -DateKind String -Depth 60 -ErrorAction Stop
        }
        catch { throw "The publication recovery result is malformed." }
        if ($workerResult -is [Array] -or (Get-Value $workerResult "valid" $false) -ne $true -or
            [string](Get-Value $workerResult "runId" "") -cne $ManifestInfo.RunId -or
            [string](Get-Value $workerResult "manifestSha256" "") -cne $ManifestInfo.Sha256 -or
            [string](Get-Value $workerResult "status" "") -notin @("publication_recovered", "publication_reconciled") -or
            (Get-Value $workerResult "trafficStarted" $true) -ne $false -or
            (Get-Value $workerResult "leaseAcquired" $true) -ne $false) {
            throw "Publication recovery did not return an exact filesystem-only completion."
        }
        $journal = Read-JournalStatus $ManifestInfo $Control -RequireTerminal
        $receipt = Read-PreparationReceiptStatus $ManifestInfo $Control -Required
        $receiptVerification = Get-RequiredValue $receipt.value "verification"
        $verificationCountsAndGatesSha256 = Assert-Sha256 `
            ([string](Get-RequiredValue $receiptVerification "countsAndGatesSha256")) `
            "fixture verification counts/gates sha256"
        if ([string](Get-Value $workerResult "journalTerminalHash" "") -cne $journal.lastRecordHash -or
            [string](Get-Value $workerResult "fixturePreparationReceiptSha256" "") -cne $receipt.sha256 -or
            [string](Get-Value $workerResult "supervisorAdmissionSha256" "") -cne
                $recoveryAdmissionRef.sha256 -or
            [string](Get-Value $workerResult "verificationCountsAndGatesSha256" "") -cne
                $verificationCountsAndGatesSha256) {
            throw "Publication recovery does not match the terminal journal and preparation receipt."
        }
        $manifestPaths = Get-RequiredValue $ManifestInfo.Value "paths"
        $recoveryReceiptPath = Resolve-ExternalPath `
            ([string](Get-RequiredValue $manifestPaths "publicationRecoveryReceiptPath")) `
            "paths.publicationRecoveryReceiptPath" File
        Assert-PrivateAcl $recoveryReceiptPath "publication recovery receipt"
        $recoveryReceiptSha256 = Get-FileSha256 $recoveryReceiptPath
        if ([string](Get-Value $workerResult "publicationRecoveryReceiptSha256" "") -cne
            $recoveryReceiptSha256) {
            throw "Publication recovery did not bind its immutable one-use receipt."
        }
        $recoveryReceipt = Read-PrivateJson $recoveryReceiptPath
        $requiredRecoveryReceiptFields = @(
            "schemaVersion","type","version","status","runId","manifestSha256",
            "fixturePreparationReceiptSha256","recoveryNonceSha256",
            "supervisorAdmissionSha256","supervisorAdmissionNonceSha256",
            "originalSupervisorTicketSha256","admittedAtUtc"
        )
        $actualRecoveryReceiptFields = @($recoveryReceipt.PSObject.Properties.Name)
        if (@(Compare-Object ($requiredRecoveryReceiptFields | Sort-Object) `
                ($actualRecoveryReceiptFields | Sort-Object)).Count -ne 0) {
            throw "The one-use publication recovery receipt fields are invalid."
        }
        $admissionNonceSha256 = [string](Get-RequiredValue $recoveryAdmission "recoveryNonceSha256")
        $sealedRecovery = Get-RequiredValue $receipt.value "recovery"
        $sealedRecoveryNonceSha256 = Get-TextSha256 `
            ([string](Get-RequiredValue $sealedRecovery "nonce"))
        $admittedAtUtc = [string](Get-RequiredValue $recoveryReceipt "admittedAtUtc")
        $parsedAdmittedAtUtc = [DateTimeOffset]::MinValue
        if ([int](Get-Value $recoveryReceipt "schemaVersion" 0) -ne 1 -or
            [string](Get-Value $recoveryReceipt "type" "") -cne "fixture_publication_recovery_receipt" -or
            [string](Get-Value $recoveryReceipt "version" "") -cne $script:RecoveryReceiptVersion -or
            [string](Get-Value $recoveryReceipt "status" "") -cne "admitted" -or
            [string](Get-Value $recoveryReceipt "runId" "") -cne $ManifestInfo.RunId -or
            [string](Get-Value $recoveryReceipt "manifestSha256" "") -cne $ManifestInfo.Sha256 -or
            [string](Get-Value $recoveryReceipt "fixturePreparationReceiptSha256" "") -cne $receipt.sha256 -or
            [string](Get-Value $recoveryReceipt "recoveryNonceSha256" "") -cne
                $sealedRecoveryNonceSha256 -or
            [string](Get-Value $recoveryReceipt "supervisorAdmissionSha256" "") -cne
                $recoveryAdmissionRef.sha256 -or
            [string](Get-Value $recoveryReceipt "supervisorAdmissionNonceSha256" "") -cne
                $admissionNonceSha256 -or
            [string](Get-Value $recoveryReceipt "originalSupervisorTicketSha256" "") -cne
                $ticket.sha256 -or
            -not [DateTimeOffset]::TryParseExact(
                $admittedAtUtc, "o", [Globalization.CultureInfo]::InvariantCulture,
                [Globalization.DateTimeStyles]::None, [ref]$parsedAdmittedAtUtc
            ) -or $parsedAdmittedAtUtc.Offset -ne [TimeSpan]::Zero) {
            throw "The one-use publication recovery receipt identity is invalid."
        }
        $journalRecords = @(Get-Content -LiteralPath $Control.Journal |
            Where-Object { -not [string]::IsNullOrWhiteSpace($_) } |
            ForEach-Object { $_ | ConvertFrom-Json -DateKind String -Depth 60 })
        $recoveryStarted = @($journalRecords | Where-Object {
            [string](Get-Value $_ "stage" "") -ceq "publication_recovery_started" -and
            [string](Get-Value $_ "status" "") -ceq "running"
        })
        $recoveryCompleted = @($journalRecords | Where-Object {
            [string](Get-Value $_ "stage" "") -ceq "publication_recovery_completed" -and
            [string](Get-Value $_ "status" "") -ceq "completed"
        })
        $terminalArtifactHashes = Get-RequiredValue $journalRecords[-1] "artifactHashes"
        if ($recoveryStarted.Count -ne 1 -or $recoveryCompleted.Count -ne 1 -or
            [string](Get-Value (Get-RequiredValue $recoveryStarted[0] "artifactHashes") `
                "publicationRecoveryReceiptSha256" "") -cne $recoveryReceiptSha256 -or
            [string](Get-Value (Get-RequiredValue $recoveryCompleted[0] "artifactHashes") `
                "publicationRecoveryReceiptSha256" "") -cne $recoveryReceiptSha256 -or
            [string](Get-Value $terminalArtifactHashes "publicationRecoveryReceiptSha256" "") -cne
                $recoveryReceiptSha256) {
            throw "The terminal journal does not bind the exact one-use publication recovery receipt."
        }
        $result = [ordered]@{
            schemaVersion = 1; type = "waf800_diagnostic_prep_supervisor_result"; version = $script:SupervisorVersion
            runId = $ManifestInfo.RunId
            manifest = [ordered]@{ path = $ManifestInfo.Path; sha256 = $ManifestInfo.Sha256 }
            ticket = [ordered]@{ path = $ticket.path; sha256 = $ticket.sha256 }
            recoveryAdmission = $recoveryAdmissionRef
            publicationRecoveryReceipt = [ordered]@{
                path = $recoveryReceiptPath
                sha256 = $recoveryReceiptSha256
            }
            supervisorRunLock = [ordered]@{ path = $recoveryFileLock.path; sha256 = $recoveryFileLock.sha256 }
            supervisorAdmissionSha256 = $recoveryAdmissionRef.sha256
            verificationCountsAndGatesSha256 = $verificationCountsAndGatesSha256
            status = "completed"; completedAtUtc = [DateTimeOffset]::UtcNow.ToString("o")
            supervisor = $currentSupervisor
            originalExecution = $originalExecution
            recovery = [ordered]@{
                status = [string]$workerResult.status
                worker = $observation
                workerOwnership = $recoveryOwnershipRef
            }
            journal = [ordered]@{ path = $Control.Journal; sha256 = $journal.sha256; recordCount = $journal.recordCount; terminalHash = $journal.lastRecordHash; terminalCommitted = $true }
            fixturePreparationReceipt = [ordered]@{ path = $receipt.path; sha256 = $receipt.sha256 }
            terminalEvidenceCommitted = $true; trafficStarted = $false; leaseAcquired = $false; rawErrorPersisted = $false
        }
        Write-PrivateJson $Control.RecoveryResult $result -Immutable
        $resultRef = [ordered]@{ path = $Control.RecoveryResult; sha256 = Get-FileSha256 $Control.RecoveryResult }
        $afterResultCommitDelay = Get-OfflineTestDelayMilliseconds $ManifestInfo `
            "supervisorAfterResultCommitDelayMilliseconds"
        if ($afterResultCommitDelay -gt 0) {
            Start-Sleep -Milliseconds $afterResultCommitDelay
        }
        $state = New-SupervisorState $ManifestInfo $ticket "completed" $currentSupervisor `
            $recoveryIdentity $observation $journal $resultRef
        $state.originalExecution = $originalExecution
        $state.workerOwnership = $recoveryOwnershipRef
        $state.recoveryAdmission = $recoveryAdmissionRef
        Write-PrivateJson $Control.State $state
        return $result
    }
    catch {
        $caught = $_
        if ($null -ne $process -and -not $process.HasExited) {
            Close-DiagnosticPrepJob $recoveryJob
            $recoveryJob = [IntPtr]::Zero
            if (-not $process.WaitForExit(10000)) { Stop-BoundProcess $process }
        }
        if ($null -ne $originalExecution -and $null -ne $recoveryAdmissionRef) {
            $code = if ($caught.Exception -is [TimeoutException]) {
                "publication_recovery_timeout"
            }
            else { "publication_recovery_failed" }
            $failure = New-SanitizedFailure $code "publication_recovery" $caught.Exception.Message
            $originalResultReference = [ordered]@{
                path = $Control.Result
                sha256 = $originalResultSha256
                status = $originalStatus
            }
            $state = New-SupervisorState $ManifestInfo $ticket "failed" $currentSupervisor `
                $recoveryIdentity $observation $null $originalResultReference $failure
            $state.originalExecution = $originalExecution
            $state.workerOwnership = $recoveryOwnershipRef
            $state.recoveryAdmission = $recoveryAdmissionRef
            Write-PrivateJson $Control.State $state
        }
        throw $caught
    }
    finally {
        Close-DiagnosticPrepJob $recoveryJob
        if ($null -ne $boundRecoveryLaunch -and $boundRecoveryLaunch.Resumed -ne $true) {
            $boundRecoveryLaunch.NativeLaunch.Dispose()
        }
        if ($null -ne $process) { $process.Dispose() }
        if ($null -ne $recoveryFileLock) { $recoveryFileLock.stream.Dispose() }
        Exit-OwnedMutex $recoverySupervisorMutex
    }
}

function Write-JsonOutput {
    param($Value)
    [Console]::Out.WriteLine(($Value | ConvertTo-Json -Depth 60 -Compress))
}

function Enter-SupervisorLogRedirection {
    param($Control)
    foreach ($path in @($Control.SupervisorStdout, $Control.SupervisorStderr)) {
        if (-not (Test-Path -LiteralPath $path -PathType Leaf)) {
            throw "The admitted supervisor log file is missing."
        }
        Assert-PrivateAcl $path "supervisor log"
    }
    $stdoutStream = [IO.FileStream]::new(
        $Control.SupervisorStdout, [IO.FileMode]::Append, [IO.FileAccess]::Write, [IO.FileShare]::Read
    )
    try {
        $stderrStream = [IO.FileStream]::new(
            $Control.SupervisorStderr, [IO.FileMode]::Append, [IO.FileAccess]::Write, [IO.FileShare]::Read
        )
    }
    catch {
        $stdoutStream.Dispose()
        throw
    }
    $stdoutWriter = [IO.StreamWriter]::new($stdoutStream, [Text.UTF8Encoding]::new($false))
    $stderrWriter = [IO.StreamWriter]::new($stderrStream, [Text.UTF8Encoding]::new($false))
    $stdoutWriter.AutoFlush = $true
    $stderrWriter.AutoFlush = $true
    [Console]::SetOut($stdoutWriter)
    [Console]::SetError($stderrWriter)
    return [pscustomobject]@{ stdout = $stdoutWriter; stderr = $stderrWriter }
}

$supervisorLogWriters = $null
try {
    if (-not $IsWindows) { throw "Waf/800 diagnostic preparation supervision is Windows-only." }
    $manifestInfo = Read-PreparationManifest $ManifestPath $ExpectedManifestSha256
    $control = Get-ControlPaths $manifestInfo $TicketPath
    if ($Mode -eq "Supervise") {
        $supervisorLogWriters = Enter-SupervisorLogRedirection $control
    }
    $result = switch ($Mode) {
        "Validate" { Invoke-ValidateMode $manifestInfo; break }
        "Start" { Invoke-StartMode $manifestInfo $control; break }
        "Status" { Invoke-StatusMode $manifestInfo $control; break }
        "ResumePublication" { Invoke-ResumePublicationMode $manifestInfo $control; break }
        "Supervise" { Invoke-SuperviseMode $manifestInfo $control; break }
    }
    Write-JsonOutput $result
    if ($Mode -eq "Supervise" -and [string](Get-Value $result "status" "") -ne "completed") { exit 1 }
}
catch {
    $failure = [ordered]@{
        schemaVersion = 1
        type = "diagnostic_prep_supervisor_failure"
        version = $script:SupervisorVersion
        mode = $Mode
        status = "failed"
        failureCode = "diagnostic_preparation_supervisor_rejected"
        failureStage = if ([string]::IsNullOrWhiteSpace($script:FailureDetailStage)) {
            "supervisor_$($Mode.ToLowerInvariant())"
        } else { $script:FailureDetailStage }
        messageSha256 = Get-TextSha256 $_.Exception.Message
        rawErrorPersisted = $false
        trafficStarted = $false
        leaseAcquired = $false
    }
    Write-JsonOutput $failure
    exit 1
}
finally {
    if ($null -ne $supervisorLogWriters) {
        try { $supervisorLogWriters.stdout.Flush() } catch { }
        try { $supervisorLogWriters.stderr.Flush() } catch { }
        try { $supervisorLogWriters.stdout.Dispose() } catch { }
        try { $supervisorLogWriters.stderr.Dispose() } catch { }
    }
}
