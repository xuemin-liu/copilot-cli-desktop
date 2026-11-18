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
  // The fixed prefix of SYSTEM_PROCESS_INFORMATION (winternl.h). The variable
  // thread array and image name are skipped using NextEntryOffset.
  const processPrefix = koffi.struct({
    next: 'uint32', threads: 'uint32', workingSetPrivate: 'int64', hardFaults: 'uint32',
    highWatermark: 'uint32', cycles: 'uint64', created: 'int64', user: 'int64', kernel: 'int64',
    nameLength: 'uint16', nameCapacity: 'uint16', nameBuffer: 'uintptr', priority: 'int32',
    pid: 'uintptr', parent: 'uintptr',
  })
  const pidOffset = koffi.offsetof(processPrefix, 'pid'), parentOffset = koffi.offsetof(processPrefix, 'parent')
  const createdOffset = koffi.offsetof(processPrefix, 'created')
  const prefixSize = koffi.sizeof(processPrefix)
  const query = koffi.load('ntdll.dll').func('int32 __stdcall NtQuerySystemInformation(uint32 infoClass, void *info, uint32 size, void *written)')
  let processBuffer = Buffer.alloc(1024 * 1024)
  const written = Buffer.alloc(4)
  let supportsBasicInventory = true
  function inventory(infoClass: number): number {
    for (;;) {
      const status = query(infoClass, processBuffer, processBuffer.length, written)
      const size = written.readUInt32LE()
      if (status === -1073741821 /* STATUS_INVALID_INFO_CLASS */ && infoClass === 252) return 0
      if (status === -1073741820 /* STATUS_INFO_LENGTH_MISMATCH */) {
        const capacity = Math.max(size + 65536, processBuffer.length * 2)
        if (capacity > 64 * 1024 * 1024) throw new Error('Process inventory exceeds size limit')
        processBuffer = Buffer.alloc(capacity)
        continue
      }
      if (status < 0 || !size || size > processBuffer.length) throw new Error(`Process inventory failed (NTSTATUS ${status})`)
      return size
    }
  }
  function* records(size: number, minimum: number): Generator<number> {
    for (let offset = 0; offset + minimum <= size;) {
      yield offset
      const step = processBuffer.readUInt32LE(offset)
      if (step === 0) return
      if (step < minimum) break
      offset += step
    }
    throw new Error('Incomplete process inventory')
  }
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
    mayHaveChildren(pid: number): boolean {
      // SystemBasicProcessInformation avoids collecting per-thread timing data.
      // Older Windows versions fall back to the full inventory.
      if (!supportsBasicInventory) return true
      const size = inventory(252)
      if (!size) { supportsBasicInventory = false; return true }
      const pointerSize = koffi.sizeof('uintptr')
      const parentOffset = 2 * pointerSize // NextEntryOffset, UniqueProcessId, InheritedFromUniqueProcessId
      for (const offset of records(size, parentOffset + pointerSize)) {
        if (processBuffer.readUInt32LE(offset + parentOffset) === pid) return true
      }
      return false
    },
    processes(): Map<number, ProcessIdentity[]> {
      const size = inventory(5 /* SystemProcessInformation */)
      const children = new Map<number, ProcessIdentity[]>()
      for (const offset of records(size, prefixSize)) {
        // Windows process IDs fit in a DWORD even in a pointer-sized field.
        const pid = processBuffer.readUInt32LE(offset + pidOffset)
        const parent = processBuffer.readUInt32LE(offset + parentOffset)
        const entry = { pid, created: processBuffer.readBigUInt64LE(offset + createdOffset) }
        const siblings = children.get(parent)
        if (siblings) siblings.push(entry)
        else children.set(parent, [entry])
      }
      return children
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

interface ProcessIdentity { pid: number; created: bigint }

/** Each inventory covers every descendant visible at that instant. Only newly
 * assigned parents need another pass for processes born before their assignment. */
export function enrollDescendants(root: ProcessIdentity, mayHaveChildren: (pid: number) => boolean,
  inventory: () => Map<number, ProcessIdentity[]>, enroll: (child: ProcessIdentity) => boolean): void {
  if (!mayHaveChildren(root.pid)) return
  let parents = [root]
  while (parents.length) {
    const children = inventory()
    const newlyAssigned: ProcessIdentity[] = []
    for (const parent of parents) {
      for (const entry of children.get(parent.pid) ?? []) {
        if (entry.pid === parent.pid || entry.created < parent.created || !enroll(entry)) continue
        parents.push(entry)
        newlyAssigned.push(entry)
      }
    }
    parents = newlyAssigned
  }
}

function assignExistingDescendants(api: ReturnType<typeof loadJobApi>, job: unknown, pid: number, root: unknown): void {
  // Keep the handles until the walk finishes so known parent IDs cannot be reused.
  const handles: unknown[] = []
  try {
    enrollDescendants({ pid, created: api.created(root) }, api.mayHaveChildren, api.processes, entry => {
      const child = api.open(0x101101 /* query limited + synchronize + set quota + terminate */, 0, entry.pid)
      if (!child) {
        const error = api.lastError()
        if (error !== 87) reportFailure(`Could not open descendant ${entry.pid} (${error})`)
        return false
      }
      handles.push(child)
      try {
        // Check the sampled identity on the opened handle in case the PID was recycled.
        if (api.created(child) !== entry.created || api.contains(job, child)) return false
        if (!api.assign(job, child)) {
          const error = api.lastError()
          if (api.wait(child, 0) !== 0) throw new Error(`Could not assign descendant ${entry.pid} (${error})`)
        }
        return true
      } catch (error) { reportFailure(error); return false }
    })
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
