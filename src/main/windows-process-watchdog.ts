import { createRequire } from 'node:module'

export interface ProcessWatchdogLease {
  release(): void
}

const require = createRequire(import.meta.url)
let failureReported = false
let failureReporter: (message: string) => void = message => console.error(message)

export function configureWindowsProcessWatchdogReporter(reporter: (message: string) => void): void {
  failureReporter = reporter
}

function reportFailure(error: unknown): void {
  if (failureReported) return
  failureReported = true
  failureReporter(`Windows child-process watchdog is unavailable: ${error instanceof Error ? error.message : String(error)}`)
}

function loadJobApi() {
  const koffi = require('koffi') as typeof import('koffi').default
  const kernel = koffi.load('kernel32.dll')
  const basic = koffi.struct({
    PerProcessUserTimeLimit: 'int64', PerJobUserTimeLimit: 'int64', LimitFlags: 'uint32',
    MinimumWorkingSetSize: 'size_t', MaximumWorkingSetSize: 'size_t', ActiveProcessLimit: 'uint32',
    Affinity: 'uintptr', PriorityClass: 'uint32', SchedulingClass: 'uint32',
  })
  const extended = koffi.struct({
    BasicLimitInformation: basic, IoInfo: koffi.array('uint64', 6),
    ProcessMemoryLimit: 'size_t', JobMemoryLimit: 'size_t', PeakProcessMemoryUsed: 'size_t', PeakJobMemoryUsed: 'size_t',
  })
  const setInfo = kernel.func('int __stdcall SetInformationJobObject(void *job, int infoClass, void *info, uint32_t size)')
  const emptyLimits = Buffer.alloc(koffi.sizeof(extended))
  const killOnClose = Buffer.from(emptyLimits)
  killOnClose.writeUInt32LE(0x2000, koffi.offsetof(basic, 'LimitFlags')) // JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE
  const processEntry = koffi.struct({
    dwSize: 'uint32', cntUsage: 'uint32', th32ProcessID: 'uint32', th32DefaultHeapID: 'uintptr',
    th32ModuleID: 'uint32', cntThreads: 'uint32', th32ParentProcessID: 'uint32',
    pcPriClassBase: 'int32', dwFlags: 'uint32', szExeFile: koffi.array('uint16', 260),
  })
  const snapshot = kernel.func('intptr __stdcall CreateToolhelp32Snapshot(uint32 flags, uint32 pid)')
  const first = kernel.func('int __stdcall Process32FirstW(intptr snapshot, void *entry)')
  const next = kernel.func('int __stdcall Process32NextW(intptr snapshot, void *entry)')
  const closeSnapshot = kernel.func('int __stdcall CloseHandle(intptr handle)')
  const times = kernel.func('int __stdcall GetProcessTimes(void *process, void *created, void *exited, void *kernel, void *user)')
  const inJob = kernel.func('int __stdcall IsProcessInJob(void *process, void *job, void *result)')
  const lastError = kernel.func('uint32_t __stdcall GetLastError()')
  return {
    create: kernel.func('void * __stdcall CreateJobObjectW(void *attributes, void *name)'),
    open: kernel.func('void * __stdcall OpenProcess(uint32_t access, int inherit, uint32_t pid)'),
    assign: kernel.func('int __stdcall AssignProcessToJobObject(void *job, void *process)'),
    wait: kernel.func('uint32_t __stdcall WaitForSingleObject(void *handle, uint32_t timeout)'),
    close: kernel.func('int __stdcall CloseHandle(void *handle)'),
    lastError,
    processes(): Map<number, number> {
      const handle = snapshot(2 /* TH32CS_SNAPPROCESS */, 0)
      if (handle === -1 || handle === -1n) throw new Error(`Process snapshot failed (${lastError()})`)
      try {
        const entry = Buffer.alloc(koffi.sizeof(processEntry))
        entry.writeUInt32LE(entry.length)
        const parents = new Map<number, number>()
        let found = first(handle, entry)
        while (found) {
          parents.set(entry.readUInt32LE(koffi.offsetof(processEntry, 'th32ProcessID')),
            entry.readUInt32LE(koffi.offsetof(processEntry, 'th32ParentProcessID')))
          found = next(handle, entry)
        }
        if (lastError() !== 18 /* ERROR_NO_MORE_FILES */) throw new Error(`Process enumeration failed (${lastError()})`)
        return parents
      } finally { closeSnapshot(handle) }
    },
    created(process: unknown): bigint {
      const created = Buffer.alloc(8), exited = Buffer.alloc(8), kernelTime = Buffer.alloc(8), user = Buffer.alloc(8)
      if (!times(process, created, exited, kernelTime, user)) throw new Error(`GetProcessTimes failed (${lastError()})`)
      return created.readBigUInt64LE()
    },
    contains(job: unknown, process: unknown): boolean {
      const result = Buffer.alloc(4)
      if (!inJob(process, job, result)) throw new Error(`IsProcessInJob failed (${lastError()})`)
      return result.readUInt32LE() !== 0
    },
    setKillOnClose(job: unknown, enabled: boolean) {
      return setInfo(job, 9 /* JobObjectExtendedLimitInformation */, enabled ? killOnClose : emptyLimits, emptyLimits.length)
    },
  }
}

let jobApi: ReturnType<typeof loadJobApi> | undefined

function assignExistingDescendants(api: ReturnType<typeof loadJobApi>, job: unknown, pid: number, root: unknown): void {
  // Assign each parent BEFORE enumerating its children. Children created later
  // inherit the job; already-running children need their own assignment and scan.
  // Keep handles until the entire walk finishes so known parent IDs cannot be reused.
  const parents = [{ pid, created: api.created(root) }]
  const handles: unknown[] = []
  try {
    for (const parent of parents) {
      for (const [childPid, parentPid] of api.processes()) {
        if (parentPid !== parent.pid || childPid === parent.pid) continue
        const child = api.open(0x101101 /* query limited + synchronize + set quota + terminate */, 0, childPid)
        if (!child) {
          if (api.lastError() === 87) continue // Exited since the snapshot.
          reportFailure(`Could not open descendant ${childPid} (${api.lastError()})`)
          continue
        }
        handles.push(child)
        try {
          const created = api.created(child)
          // A stale parent ID may refer to an unrelated process older than this
          // parent. Also recheck the relationship with the child handle pinned:
          // its ID might have been reused between the first snapshot and OpenProcess.
          if (created < parent.created || api.processes().get(childPid) !== parent.pid) continue
          if (api.contains(job, child)) continue // Its descendants already inherit this job.
          if (!api.assign(job, child)) {
            const error = api.lastError()
            if (api.wait(child, 0) !== 0) throw new Error(`Could not assign descendant ${childPid} (${error})`)
          }
          // Even an exited child can have living descendants with its parent ID.
          parents.push({ pid: childPid, created })
        } catch (error) { reportFailure(error) }
      }
    }
  } finally { for (const handle of handles) api.close(handle) }
}

/** The owner keeps the sole job handle. Windows closes it even on abrupt owner death. */
export function startWindowsProcessWatchdog(pid: number): ProcessWatchdogLease {
  if (!Number.isInteger(pid) || pid < 1 || pid > 0xffffffff) throw new Error('Invalid watchdog process ID')
  try {
    const api = jobApi ??= loadJobApi()
    const processHandle = api.open(0x101101 /* query limited + synchronize + set quota + terminate */, 0, pid)
    if (!processHandle) {
      const error = api.lastError()
      if (error === 87) return { release() {} } // The child exited before OpenProcess.
      throw new Error(`OpenProcess failed (${error})`)
    }
    try {
      const job = api.create(null, null)
      if (!job) throw new Error(`CreateJobObject failed (${api.lastError()})`)
      if (!api.setKillOnClose(job, true) || !api.assign(job, processHandle)) {
        const error = api.lastError()
        api.close(job)
        if (api.wait(processHandle, 0) === 0) return { release() {} } // Already exited.
        throw new Error(`Could not assign the process to a kill-on-close job (${error})`)
      }
      // Preserve the root's lease even if an inaccessible descendant prevents
      // complete enrollment; closing this armed job here would kill the session.
      try { assignExistingDescendants(api, job, pid, processHandle) } catch (error) { reportFailure(error) }
      let released = false
      return { release() {
        if (released) return
        // Disarm before closing so that a normal release preserves surviving descendants.
        if (!api.setKillOnClose(job, false)) { reportFailure(`Could not disarm the job (${api.lastError()})`); return }
        api.close(job)
        released = true
      } }
    } finally { api.close(processHandle) }
  } catch (error) {
    reportFailure(error)
    return { release() {} }
  }
}
