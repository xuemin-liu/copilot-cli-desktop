import { appendFile, mkdir } from 'node:fs/promises'
import { dirname } from 'node:path'

interface LogFiles {
  mkdir(path: string, options: { recursive: true; mode: number }): Promise<unknown>
  appendFile(path: string, data: string, options: { encoding: 'utf8'; mode: number }): Promise<unknown>
}

/**
 * Appends to private log files, creating each file's folder once instead of before every chunk of terminal output.
 * A folder removed while the app runs is made again: the append that finds it missing makes it and tries once more.
 */
export class LogAppender {
  private readonly folders = new Set<string>()

  constructor(private readonly files: LogFiles = { mkdir, appendFile }) {}

  async append(filename: string, text: string): Promise<void> {
    const folder = dirname(filename)
    if (!this.folders.has(folder)) await this.make(folder)
    try {
      await this.files.appendFile(filename, text, { encoding: 'utf8', mode: 0o600 })
    } catch (error) {
      if ((error as NodeJS.ErrnoException | null)?.code !== 'ENOENT') throw error
      this.folders.delete(folder)
      await this.make(folder)
      await this.files.appendFile(filename, text, { encoding: 'utf8', mode: 0o600 })
    }
  }

  private async make(folder: string): Promise<void> {
    await this.files.mkdir(folder, { recursive: true, mode: 0o700 })
    this.folders.add(folder)
  }
}
