import type { AgentSideConnection } from '@agentclientprotocol/sdk'
import { readFileSync, writeFileSync } from 'node:fs'
import { isAbsolute, resolve as resolvePath } from 'node:path'

/** ACP client capabilities that let pi delegate work back to the editor. */
export type ClientDelegationCapabilities = {
  readTextFile: boolean
  writeTextFile: boolean
  terminal: boolean
}

export const NO_CLIENT_DELEGATION_CAPABILITIES: ClientDelegationCapabilities = {
  readTextFile: false,
  writeTextFile: false,
  terminal: false
}

/**
 * File access routed through the ACP client when it advertises `fs` capabilities,
 * with a plain-disk fallback otherwise (or when a client call fails).
 *
 * Reading through the client matters because editors like Zed serve file content
 * from the open buffer, including unsaved edits; disk reads would be stale.
 */
export class ClientFs {
  constructor(
    private readonly conn: AgentSideConnection,
    private readonly sessionId: string,
    private readonly cwd: string,
    private readonly capabilities: ClientDelegationCapabilities
  ) {}

  // ACP requires absolute paths; pi tools commonly produce cwd-relative ones.
  private resolve(path: string): string {
    return isAbsolute(path) ? path : resolvePath(this.cwd, path)
  }

  // The disk fallbacks are deliberately synchronous: without a client round trip
  // the file is captured/written before this call returns to the event loop, which
  // pre-mutation snapshots rely on (pi mutates the file concurrently).
  async readTextFile(path: string): Promise<string> {
    const abs = this.resolve(path)

    if (!this.capabilities.readTextFile) {
      return readFileSync(abs, 'utf8')
    }

    try {
      const res = await this.conn.readTextFile({ sessionId: this.sessionId, path: abs })
      return res.content
    } catch {
      return readFileSync(abs, 'utf8')
    }
  }

  async writeTextFile(path: string, content: string): Promise<void> {
    const abs = this.resolve(path)

    if (!this.capabilities.writeTextFile) {
      writeFileSync(abs, content, 'utf8')
      return
    }

    try {
      await this.conn.writeTextFile({ sessionId: this.sessionId, path: abs, content })
    } catch {
      writeFileSync(abs, content, 'utf8')
    }
  }
}
