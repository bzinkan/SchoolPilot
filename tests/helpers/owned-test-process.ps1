if ($IsWindows -and $null -eq ("SchoolPilot.Tests.OwnedProcessJob" -as [type])) {
    Add-Type -TypeDefinition @'
using System;
using System.ComponentModel;
using System.Diagnostics;
using System.Runtime.InteropServices;
using Microsoft.Win32.SafeHandles;

namespace SchoolPilot.Tests
{
    public static class OwnedProcessJob
    {
        private const uint JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE = 0x00002000;
        private const int JobObjectExtendedLimitInformation = 9;

        [StructLayout(LayoutKind.Sequential)]
        private struct JOBOBJECT_BASIC_LIMIT_INFORMATION
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
        private struct IO_COUNTERS
        {
            public ulong ReadOperationCount;
            public ulong WriteOperationCount;
            public ulong OtherOperationCount;
            public ulong ReadTransferCount;
            public ulong WriteTransferCount;
            public ulong OtherTransferCount;
        }

        [StructLayout(LayoutKind.Sequential)]
        private struct JOBOBJECT_EXTENDED_LIMIT_INFORMATION
        {
            public JOBOBJECT_BASIC_LIMIT_INFORMATION BasicLimitInformation;
            public IO_COUNTERS IoInfo;
            public UIntPtr ProcessMemoryLimit;
            public UIntPtr JobMemoryLimit;
            public UIntPtr PeakProcessMemoryUsed;
            public UIntPtr PeakJobMemoryUsed;
        }

        [DllImport("kernel32.dll", CharSet = CharSet.Unicode, SetLastError = true)]
        private static extern SafeFileHandle CreateJobObject(IntPtr jobAttributes, string name);

        [DllImport("kernel32.dll", SetLastError = true)]
        private static extern bool SetInformationJobObject(
            SafeFileHandle job,
            int infoClass,
            IntPtr info,
            uint infoLength);

        [DllImport("kernel32.dll", SetLastError = true)]
        private static extern bool AssignProcessToJobObject(SafeFileHandle job, IntPtr processHandle);

        public static SafeFileHandle CreateKillOnCloseJob()
        {
            SafeFileHandle job = CreateJobObject(IntPtr.Zero, null);
            if (job == null || job.IsInvalid)
                throw new Win32Exception(Marshal.GetLastWin32Error(), "CreateJobObject failed.");

            var limits = new JOBOBJECT_EXTENDED_LIMIT_INFORMATION();
            limits.BasicLimitInformation.LimitFlags = JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE;
            int size = Marshal.SizeOf<JOBOBJECT_EXTENDED_LIMIT_INFORMATION>();
            IntPtr buffer = Marshal.AllocHGlobal(size);
            try
            {
                Marshal.StructureToPtr(limits, buffer, false);
                if (!SetInformationJobObject(job, JobObjectExtendedLimitInformation, buffer, (uint)size))
                    throw new Win32Exception(Marshal.GetLastWin32Error(), "SetInformationJobObject failed.");
            }
            catch
            {
                job.Dispose();
                throw;
            }
            finally
            {
                Marshal.FreeHGlobal(buffer);
            }
            return job;
        }

        public static void Assign(SafeFileHandle job, Process process)
        {
            if (!AssignProcessToJobObject(job, process.Handle))
                throw new Win32Exception(Marshal.GetLastWin32Error(), "AssignProcessToJobObject failed.");
        }
    }
}
'@
}

function Add-OwnedTestProcessCleanupFailures {
    param(
        [Parameter(Mandatory = $true)]
        [Exception]$Exception,
        [Parameter(Mandatory = $true)]
        [Exception[]]$CleanupFailures
    )

    $mergedFailures = [System.Collections.Generic.List[Exception]]::new()
    if ($Exception.Data.Contains("CleanupFailures")) {
        foreach ($existingFailure in @($Exception.Data["CleanupFailures"])) {
            if ($existingFailure -is [Exception]) {
                $mergedFailures.Add($existingFailure)
            }
            elseif ($null -ne $existingFailure) {
                $mergedFailures.Add([InvalidOperationException]::new([string]$existingFailure))
            }
        }
    }
    foreach ($cleanupFailure in @($CleanupFailures)) {
        if ($null -ne $cleanupFailure) { $mergedFailures.Add($cleanupFailure) }
    }
    $Exception.Data["CleanupFailures"] = [Exception[]]$mergedFailures.ToArray()
}

function Write-OwnedTestProcessRedirectsInternal {
    param(
        [Parameter(Mandatory = $true)]
        [object]$Owner,
        [Parameter(Mandatory = $true)]
        [string]$Name,
        [ValidateRange(1, 300000)]
        [int]$TimeoutMilliseconds = 20000
    )

    if ($Owner.redirectsWritten) { return }

    $failures = [System.Collections.Generic.List[Exception]]::new()
    $redirects = @(
        [pscustomobject]@{ label = "stdout"; enabled = $Owner.redirectStandardOutput; task = $Owner.standardOutputTask; path = $Owner.standardOutputPath },
        [pscustomobject]@{ label = "stderr"; enabled = $Owner.redirectStandardError; task = $Owner.standardErrorTask; path = $Owner.standardErrorPath }
    )
    $drainTasks = [System.Collections.Generic.List[Threading.Tasks.Task]]::new()
    foreach ($redirect in $redirects) {
        if (-not $redirect.enabled) { continue }
        if ($null -eq $redirect.task) {
            $failures.Add([InvalidOperationException]::new(
                "The $($redirect.label) async drain task was not initialized for owned test process '$Name'."
            ))
            continue
        }
        $drainTasks.Add($redirect.task)
    }

    if ($drainTasks.Count -gt 0) {
        try {
            $combinedDrain = [Threading.Tasks.Task]::WhenAll([Threading.Tasks.Task[]]$drainTasks.ToArray())
            if (-not $combinedDrain.Wait($TimeoutMilliseconds)) {
                throw "Timed out draining redirected streams after ${TimeoutMilliseconds}ms."
            }
        }
        catch {
            $failures.Add([InvalidOperationException]::new(
                "Concurrent redirected-stream drain failed for owned test process '$Name'.",
                $_.Exception
            ))
        }
    }

    foreach ($redirect in $redirects) {
        if (-not $redirect.enabled -or $null -eq $redirect.task -or
            -not $redirect.task.IsCompletedSuccessfully) { continue }
        try {
            $content = $redirect.task.GetAwaiter().GetResult()
            if (-not [string]::IsNullOrWhiteSpace($redirect.path)) {
                [IO.File]::WriteAllText(
                    $redirect.path,
                    [string]$content,
                    [Text.UTF8Encoding]::new($false)
                )
            }
        }
        catch {
            $failures.Add([InvalidOperationException]::new(
                "Could not persist $($redirect.label) for owned test process '$Name'.",
                $_.Exception
            ))
        }
    }

    if ($failures.Count -gt 0) {
        throw [AggregateException]::new(
            "Could not drain redirected output for owned test process '$Name'.",
            [Exception[]]$failures.ToArray()
        )
    }
    $Owner.redirectsWritten = $true
}

function Close-OwnedTestProcessJobInternal {
    param(
        [Parameter(Mandatory = $true)]
        [object]$Owner,
        [Parameter(Mandatory = $true)]
        [string]$Name
    )

    if ($null -eq $Owner.job -or $Owner.job.IsClosed) { return }
    try {
        $Owner.job.Dispose()
        $Owner.jobClosed = $true
    }
    catch {
        throw [InvalidOperationException]::new(
            "Windows Job Object close failed for owned test process '$Name'.",
            $_.Exception
        )
    }
}

function Stop-OwnedTestProcessInternal {
    param(
        [Parameter(Mandatory = $true)]
        [object]$Owner,
        [Parameter(Mandatory = $true)]
        [string]$Name
    )

    $process = $Owner.process
    $rebound = $null
    $failures = [System.Collections.Generic.List[Exception]]::new()
    try {
        try {
            # Closing a kill-on-close job terminates every descendant even when
            # the root exited before cleanup and can no longer enumerate them.
            Close-OwnedTestProcessJobInternal -Owner $Owner -Name $Name
        }
        catch {
            $failures.Add([InvalidOperationException]::new(
                "Windows Job Object close failed for owned test process '$Name'.",
                $_.Exception
            ))
        }

        try {
            $process.Refresh()
            if (-not $process.HasExited) {
                try { $process.Kill($true) }
                catch [InvalidOperationException] {
                    $process.Refresh()
                    if (-not $process.HasExited) { throw }
                }
            }

            if (-not $process.WaitForExit(10000)) {
                if ($null -eq $Owner.id) {
                    throw "Owned test process '$Name' has no captured PID for the drain fallback."
                }
                $rebound = Get-Process -Id $Owner.id -ErrorAction SilentlyContinue
                if ($null -ne $rebound) {
                    if ($null -eq $Owner.startedAtUtc -or
                        $rebound.StartTime.ToUniversalTime() -ne $Owner.startedAtUtc) {
                        throw "PID creation identity changed while draining owned test process '$Name'."
                    }
                    $rebound.Refresh()
                    if (-not $rebound.HasExited) {
                        try { $rebound.Kill($true) }
                        catch [InvalidOperationException] {
                            $rebound.Refresh()
                            if (-not $rebound.HasExited) { throw }
                        }
                    }
                    if (-not $rebound.WaitForExit(20000)) {
                        throw "Timed out draining owned test process '$Name' after direct-root fallback."
                    }
                    $rebound.WaitForExit()
                }
                else {
                    $process.WaitForExit()
                }
            }
            else {
                # The parameterless wait completes native exit notification.
                $process.WaitForExit()
            }
        }
        catch {
            $failures.Add([InvalidOperationException]::new(
                "Process termination failed for owned test process '$Name'.",
                $_.Exception
            ))
        }

        try { Write-OwnedTestProcessRedirectsInternal -Owner $Owner -Name $Name }
        catch {
            $failures.Add([InvalidOperationException]::new(
                "Redirect drain failed for owned test process '$Name'.",
                $_.Exception
            ))
        }
    }
    finally {
        if ($null -ne $rebound -and -not [object]::ReferenceEquals($rebound, $process)) {
            $rebound.Dispose()
        }
        if ($failures.Count -eq 0) {
            $process.Dispose()
        }
    }

    if ($failures.Count -gt 0) {
        throw [AggregateException]::new(
            "Could not fully clean owned test process '$Name'.",
            [Exception[]]$failures.ToArray()
        )
    }
}

function Start-OwnedTestProcessFromStartInfo {
    param(
        [Parameter(Mandatory = $true)]
        [Collections.IDictionary]$Registry,
        [Parameter(Mandatory = $true)]
        [string]$Name,
        [Parameter(Mandatory = $true)]
        [Diagnostics.ProcessStartInfo]$StartInfo,
        [string]$StandardOutputPath = "",
        [string]$StandardErrorPath = ""
    )

    if ($Registry.Contains($Name)) {
        throw "Owned test process name '$Name' is already registered."
    }
    if (-not [string]::IsNullOrWhiteSpace($StandardOutputPath)) {
        $StartInfo.UseShellExecute = $false
        $StartInfo.RedirectStandardOutput = $true
        $StartInfo.StandardOutputEncoding = [Text.UTF8Encoding]::new($false)
    }
    if (-not [string]::IsNullOrWhiteSpace($StandardErrorPath)) {
        $StartInfo.UseShellExecute = $false
        $StartInfo.RedirectStandardError = $true
        $StartInfo.StandardErrorEncoding = [Text.UTF8Encoding]::new($false)
    }
    if (-not [string]::IsNullOrWhiteSpace($StartInfo.Arguments)) {
        throw "Owned test process '$Name' must use ProcessStartInfo.ArgumentList; the pre-quoted Arguments string is not supported."
    }

    $process = [Diagnostics.Process]::new()
    $process.StartInfo = $StartInfo
    $job = if ($IsWindows) { [SchoolPilot.Tests.OwnedProcessJob]::CreateKillOnCloseJob() } else { $null }
    $started = $false
    $registered = $false
    $primaryFailure = $null
    $cleanupFailure = $null
    $owner = [pscustomobject]@{
        process = $process
        job = $job
        jobClosed = $false
        id = $null
        startedAtUtc = $null
        # Process.Path can be empty for packaged pwsh.exe on Windows. The
        # audited executable supplied to ProcessStartInfo is the stable path
        # that the monitor must bind to.
        path = [string]$StartInfo.FileName
        redirectStandardOutput = [bool]$StartInfo.RedirectStandardOutput
        redirectStandardError = [bool]$StartInfo.RedirectStandardError
        standardOutputTask = $null
        standardErrorTask = $null
        standardOutputPath = [string]$StandardOutputPath
        standardErrorPath = [string]$StandardErrorPath
        redirectsWritten = $false
    }
    try {
        # Reserve ownership before launch. If Start itself fails there is no
        # child and the provisional entry is removed; after Start, no
        # unregistered gap exists during metadata or redirect initialization.
        $Registry.Add($Name, $owner)
        $registered = $true
        if (-not $process.Start()) {
            throw "The operating system refused to start owned test process '$Name'."
        }
        $started = $true
        if ($IsWindows) {
            # Assignment is the first post-launch operation. A nested-job
            # restriction is a hard lifecycle failure, never a silent fallback.
            [SchoolPilot.Tests.OwnedProcessJob]::Assign($job, $process)
        }
        if ($StartInfo.RedirectStandardOutput) {
            $owner.standardOutputTask = $process.StandardOutput.ReadToEndAsync()
        }
        if ($StartInfo.RedirectStandardError) {
            $owner.standardErrorTask = $process.StandardError.ReadToEndAsync()
        }
        $owner.id = [int]$process.Id
        $owner.startedAtUtc = $process.StartTime.ToUniversalTime()
    }
    catch { $primaryFailure = $_ }
    finally {
        # Once Start succeeds, every later failure still owns a live child even
        # if identity capture, redirect setup, or registry insertion fails.
        if ($null -ne $primaryFailure -and $started -and $registered) {
            # Assignment is intentionally first after Start. If it fails,
            # initialize both async readers before cleanup so inherited pipes
            # remain drainable after the Job/direct tree kill.
            if ($StartInfo.RedirectStandardOutput -and $null -eq $owner.standardOutputTask) {
                try { $owner.standardOutputTask = $process.StandardOutput.ReadToEndAsync() }
                catch { $primaryFailure.Exception.Data["StandardOutputDrainInitializationFailure"] = $_.Exception }
            }
            if ($StartInfo.RedirectStandardError -and $null -eq $owner.standardErrorTask) {
                try { $owner.standardErrorTask = $process.StandardError.ReadToEndAsync() }
                catch { $primaryFailure.Exception.Data["StandardErrorDrainInitializationFailure"] = $_.Exception }
            }
            try { Stop-OwnedTestProcess -Registry $Registry -Name $Name }
            catch { $cleanupFailure = $_ }
        }
        elseif ($started -and -not $registered) {
            try { Stop-OwnedTestProcessInternal -Owner $owner -Name $Name }
            catch { $cleanupFailure = $_ }
        }
        elseif ($null -ne $primaryFailure -and -not $started) {
            if ($registered) { [void]$Registry.Remove($Name) }
            $registered = $false
            if ($null -ne $job -and -not $job.IsClosed) { $job.Dispose() }
            $process.Dispose()
        }
    }
    if ($null -ne $primaryFailure -and $null -ne $cleanupFailure) {
        Add-OwnedTestProcessCleanupFailures -Exception $primaryFailure.Exception `
            -CleanupFailures @($cleanupFailure.Exception)
        throw $primaryFailure
    }
    if ($null -ne $primaryFailure) { throw $primaryFailure }
    if ($null -ne $cleanupFailure) { throw $cleanupFailure }
}

function Start-OwnedTestProcess {
    param(
        [Parameter(Mandatory = $true)]
        [Collections.IDictionary]$Registry,
        [Parameter(Mandatory = $true)]
        [string]$Name,
        [Parameter(Mandatory = $true)]
        [string]$FilePath,
        [Parameter(Mandatory = $true)]
        [AllowEmptyString()]
        [string[]]$ArgumentList,
        [string]$StandardOutputPath = "",
        [string]$StandardErrorPath = ""
    )

    $startInfo = [Diagnostics.ProcessStartInfo]::new()
    $startInfo.FileName = $FilePath
    $startInfo.UseShellExecute = $false
    $startInfo.CreateNoWindow = $true
    foreach ($argument in $ArgumentList) {
        [void]$startInfo.ArgumentList.Add([string]$argument)
    }
    Start-OwnedTestProcessFromStartInfo -Registry $Registry -Name $Name -StartInfo $startInfo `
        -StandardOutputPath $StandardOutputPath -StandardErrorPath $StandardErrorPath
}

function Get-OwnedTestProcessSnapshot {
    param(
        [Parameter(Mandatory = $true)]
        [Collections.IDictionary]$Registry,
        [Parameter(Mandatory = $true)]
        [string]$Name
    )

    if (-not $Registry.Contains($Name)) {
        throw "Owned test process '$Name' is not registered."
    }
    $owner = $Registry[$Name]
    $owner.process.Refresh()
    $hasExited = $owner.process.HasExited
    return [pscustomobject]@{
        id = [int]$owner.id
        startedAtUtc = [DateTime]$owner.startedAtUtc
        path = [string]$owner.path
        hasExited = [bool]$hasExited
        exitCode = if ($hasExited) { [int]$owner.process.ExitCode } else { $null }
    }
}

function Stop-OwnedTestProcess {
    param(
        [Parameter(Mandatory = $true)]
        [Collections.IDictionary]$Registry,
        [Parameter(Mandatory = $true)]
        [string]$Name
    )

    if (-not $Registry.Contains($Name)) { return }
    $owner = $Registry[$Name]
    Stop-OwnedTestProcessInternal -Owner $owner -Name $Name
    [void]$Registry.Remove($Name)
}

function Stop-AllOwnedTestProcesses {
    param(
        [Parameter(Mandatory = $true)]
        [Collections.IDictionary]$Registry
    )

    $failures = [System.Collections.Generic.List[Exception]]::new()
    foreach ($name in @($Registry.Keys)) {
        try { Stop-OwnedTestProcess -Registry $Registry -Name ([string]$name) }
        catch {
            $failures.Add([InvalidOperationException]::new(
                "Cleanup failed for registry entry '$name'.",
                $_.Exception
            ))
        }
    }
    if ($failures.Count -gt 0) {
        throw [AggregateException]::new(
            "Could not drain all owned test processes.",
            [Exception[]]$failures.ToArray()
        )
    }
}

function Complete-OwnedTestProcess {
    param(
        [Parameter(Mandatory = $true)]
        [Collections.IDictionary]$Registry,
        [Parameter(Mandatory = $true)]
        [string]$Name,
        [ValidateRange(1, 300000)]
        [int]$TimeoutMilliseconds
    )

    if (-not $Registry.Contains($Name)) {
        throw "Owned test process '$Name' is not registered."
    }
    $owner = $Registry[$Name]
    $watch = [Diagnostics.Stopwatch]::StartNew()
    $primaryFailure = $null
    $cleanupFailure = $null
    $exitCode = $null
    try {
        if (-not $owner.process.WaitForExit($TimeoutMilliseconds)) {
            throw "Owned test process '$Name' exceeded its ${TimeoutMilliseconds}ms exit watchdog."
        }
        Close-OwnedTestProcessJobInternal -Owner $owner -Name $Name
        $owner.process.WaitForExit()
        $remainingDrainMilliseconds = $TimeoutMilliseconds - [int]$watch.ElapsedMilliseconds
        if ($remainingDrainMilliseconds -le 0) {
            throw "Owned test process '$Name' exceeded its ${TimeoutMilliseconds}ms exit-and-drain watchdog."
        }
        Write-OwnedTestProcessRedirectsInternal -Owner $owner -Name $Name `
            -TimeoutMilliseconds $remainingDrainMilliseconds
        $exitCode = $owner.process.ExitCode
    }
    catch { $primaryFailure = $_ }
    finally {
        $watch.Stop()
        try { Stop-OwnedTestProcess -Registry $Registry -Name $Name }
        catch { $cleanupFailure = $_ }
    }
    if ($null -ne $primaryFailure -and $null -ne $cleanupFailure) {
        Add-OwnedTestProcessCleanupFailures -Exception $primaryFailure.Exception `
            -CleanupFailures @($cleanupFailure.Exception)
        throw $primaryFailure
    }
    if ($null -ne $primaryFailure) { throw $primaryFailure }
    if ($null -ne $cleanupFailure) { throw $cleanupFailure }
    return [pscustomobject]@{ exitCode = [int]$exitCode; durationMs = [long]$watch.ElapsedMilliseconds }
}

function Release-OwnedTestProcess {
    param(
        [Parameter(Mandatory = $true)]
        [Collections.IDictionary]$Registry,
        [Parameter(Mandatory = $true)]
        [string]$Name,
        [Parameter(Mandatory = $true)]
        [string]$SignalPath,
        [ValidateRange(1, 300000)]
        [int]$TimeoutMilliseconds = 10000
    )

    if (-not $Registry.Contains($Name)) {
        throw "Owned test process '$Name' is not registered."
    }
    $owner = $Registry[$Name]
    $watch = [Diagnostics.Stopwatch]::StartNew()
    $primaryFailure = $null
    $cleanupFailure = $null
    $wasRunningBeforeSignal = $false
    $exitedAfterSignal = $false
    $exitCode = $null
    try {
        $owner.process.Refresh()
        $wasRunningBeforeSignal = -not $owner.process.HasExited
        [IO.File]::WriteAllText($SignalPath, "release", [Text.UTF8Encoding]::new($false))
        $exitedAfterSignal = $owner.process.WaitForExit($TimeoutMilliseconds)
        if ($exitedAfterSignal) {
            Close-OwnedTestProcessJobInternal -Owner $owner -Name $Name
            $owner.process.WaitForExit()
            $remainingDrainMilliseconds = $TimeoutMilliseconds - [int]$watch.ElapsedMilliseconds
            if ($remainingDrainMilliseconds -le 0) {
                throw "Owned test process '$Name' exceeded its ${TimeoutMilliseconds}ms release-and-drain watchdog."
            }
            Write-OwnedTestProcessRedirectsInternal -Owner $owner -Name $Name `
                -TimeoutMilliseconds $remainingDrainMilliseconds
            $exitCode = $owner.process.ExitCode
        }
    }
    catch { $primaryFailure = $_ }
    finally {
        try { Stop-OwnedTestProcess -Registry $Registry -Name $Name }
        catch { $cleanupFailure = $_ }
    }
    if ($null -ne $primaryFailure -and $null -ne $cleanupFailure) {
        Add-OwnedTestProcessCleanupFailures -Exception $primaryFailure.Exception `
            -CleanupFailures @($cleanupFailure.Exception)
        throw $primaryFailure
    }
    if ($null -ne $primaryFailure) { throw $primaryFailure }
    if ($null -ne $cleanupFailure) { throw $cleanupFailure }
    return [pscustomobject]@{
        wasRunningBeforeSignal = [bool]$wasRunningBeforeSignal
        exitedAfterSignal = [bool]$exitedAfterSignal
        exitCode = if ($null -eq $exitCode) { $null } else { [int]$exitCode }
    }
}

function Invoke-OwnedTestProcessWithResult {
    param(
        [Parameter(Mandatory = $true)]
        [Collections.IDictionary]$Registry,
        [Parameter(Mandatory = $true)]
        [string]$Name,
        [Parameter(Mandatory = $true)]
        [string]$FilePath,
        [Parameter(Mandatory = $true)]
        [AllowEmptyString()]
        [string[]]$ArgumentList,
        [Parameter(Mandatory = $true)]
        [string]$StandardOutputPath,
        [Parameter(Mandatory = $true)]
        [string]$StandardErrorPath,
        [Parameter(Mandatory = $true)]
        [string]$ResultPath,
        [ValidateRange(1000, 300000)]
        [int]$WatchdogMilliseconds = 90000
    )

    if ($Registry.Contains($Name)) {
        throw "Owned test process name '$Name' is already registered."
    }

    $watch = [Diagnostics.Stopwatch]::StartNew()
    $exitCode = $null
    $resultObserved = $false
    $processExited = $false
    $primaryFailure = $null
    $cleanupFailure = $null
    try {
        Start-OwnedTestProcess -Registry $Registry -Name $Name -FilePath $FilePath `
            -ArgumentList $ArgumentList -StandardOutputPath $StandardOutputPath `
            -StandardErrorPath $StandardErrorPath
        $owner = $Registry[$Name]

        while ($watch.ElapsedMilliseconds -lt $WatchdogMilliseconds) {
            $resultObserved = Test-Path -LiteralPath $ResultPath -PathType Leaf
            $owner.process.Refresh()
            $processExited = $owner.process.HasExited
            if ($resultObserved -and $processExited) { break }
            Start-Sleep -Milliseconds 100
        }

        $resultObserved = Test-Path -LiteralPath $ResultPath -PathType Leaf
        $owner.process.Refresh()
        $processExited = $owner.process.HasExited
        if (-not ($resultObserved -and $processExited)) {
            throw "Owned test process '$Name' exceeded its ${WatchdogMilliseconds}ms result-and-exit watchdog (resultObserved=$resultObserved, processExited=$processExited)."
        }

        Close-OwnedTestProcessJobInternal -Owner $owner -Name $Name
        $owner.process.WaitForExit()
        $remainingDrainMilliseconds = $WatchdogMilliseconds - [int]$watch.ElapsedMilliseconds
        if ($remainingDrainMilliseconds -le 0) {
            throw "Owned test process '$Name' exceeded its ${WatchdogMilliseconds}ms result-exit-and-drain watchdog."
        }
        Write-OwnedTestProcessRedirectsInternal -Owner $owner -Name $Name `
            -TimeoutMilliseconds $remainingDrainMilliseconds
        if ($watch.ElapsedMilliseconds -gt $WatchdogMilliseconds) {
            throw "Owned test process '$Name' exceeded its ${WatchdogMilliseconds}ms result-exit-and-drain watchdog."
        }
        $exitCode = $owner.process.ExitCode
    }
    catch { $primaryFailure = $_ }
    finally {
        $watch.Stop()
        if ($Registry.Contains($Name)) {
            try { Stop-OwnedTestProcess -Registry $Registry -Name $Name }
            catch { $cleanupFailure = $_ }
        }
    }

    if ($null -ne $primaryFailure -and $null -ne $cleanupFailure) {
        Add-OwnedTestProcessCleanupFailures -Exception $primaryFailure.Exception `
            -CleanupFailures @($cleanupFailure.Exception)
        throw $primaryFailure
    }
    if ($null -ne $primaryFailure) { throw $primaryFailure }
    if ($null -ne $cleanupFailure) { throw $cleanupFailure }

    return [pscustomobject]@{
        exitCode = [int]$exitCode
        resultObserved = [bool]$resultObserved
        durationMs = [long]$watch.ElapsedMilliseconds
    }
}
