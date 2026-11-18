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
  return {
    create: kernel.func('void * __stdcall CreateJobObjectW(void *attributes, void *name)'),
    open: kernel.func('void * __stdcall OpenProcess(uint32_t access, int inherit, uint32_t pid)'),
    assign: kernel.func('int __stdcall AssignProcessToJobObject(void *job, void *process)'),
    wait: kernel.func('uint32_t __stdcall WaitForSingleObject(void *handle, uint32_t timeout)'),
    close: kernel.func('int __stdcall CloseHandle(void *handle)'),
    lastError: kernel.func('uint32_t __stdcall GetLastError()'),
    setKillOnClose(job: unknown, enabled: boolean) {
      return setInfo(job, 9 /* JobObjectExtendedLimitInformation */, enabled ? killOnClose : emptyLimits, emptyLimits.length)
    },
  }
}

let jobApi: ReturnType<typeof loadJobApi> | undefined

/** The owner keeps the sole job handle. Windows closes it even on abrupt owner death. */
export function startWindowsProcessWatchdog(pid: number): ProcessWatchdogLease {
  if (!Number.isInteger(pid) || pid < 1 || pid > 0xffffffff) throw new Error('Invalid watchdog process ID')
  try {
    const api = jobApi ??= loadJobApi()
    const processHandle = api.open(0x100101 /* SYNCHRONIZE | PROCESS_SET_QUOTA | PROCESS_TERMINATE */, 0, pid)
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
