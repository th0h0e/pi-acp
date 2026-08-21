import type { AgentSideConnection } from '@agentclientprotocol/sdk'
import type { PiRpcEvent, ThinkingLevel } from '../../src/pi-rpc/process.js'

type SessionUpdateMsg = Parameters<AgentSideConnection['sessionUpdate']>[0]

export class FakeAgentSideConnection {
  readonly updates: SessionUpdateMsg[] = []
  readonly permissionRequests: unknown[] = []
  readonly readTextFileRequests: Array<{ sessionId: string; path: string }> = []
  readonly writeTextFileRequests: Array<{ sessionId: string; path: string; content: string }> = []

  // When set, readTextFile serves this content (simulates an editor buffer with
  // unsaved changes). Otherwise it rejects, as a client without the file would.
  clientFileContent: string | null = null
  failClientWrites = false

  async readTextFile(params: { sessionId: string; path: string }): Promise<{ content: string }> {
    this.readTextFileRequests.push(params)
    if (this.clientFileContent === null) throw new Error('no buffer for file')
    return { content: this.clientFileContent }
  }

  async writeTextFile(params: { sessionId: string; path: string; content: string }): Promise<void> {
    this.writeTextFileRequests.push(params)
    if (this.failClientWrites) throw new Error('client refused write')
  }
  readonly createTerminalRequests: Array<{ sessionId: string; command: string; args?: string[]; cwd?: string }> = []
  readonly killedTerminals: string[] = []
  readonly releasedTerminals: string[] = []

  // When set, createTerminal rejects, standing in for a client without the
  // terminal capability (or one that refuses a specific command).
  failCreateTerminal = false
  terminalOutput = ''
  terminalExitCode: number | null = 0
  // When true, the command runs until killed, so cancellation can be exercised.
  holdTerminals = false
  private terminalCounter = 0

  async createTerminal(params: { sessionId: string; command: string; args?: string[]; cwd?: string }) {
    this.createTerminalRequests.push(params)
    if (this.failCreateTerminal) throw new Error('client refused terminal')

    const id = `term_${this.terminalCounter++}`
    let finish: () => void = () => {}
    const exited = this.holdTerminals ? new Promise<void>(resolve => (finish = resolve)) : Promise.resolve()

    return {
      id,
      waitForExit: async () => {
        await exited
        return { exitCode: this.terminalExitCode, signal: null }
      },
      currentOutput: async () => ({
        output: this.terminalOutput,
        exitStatus: { exitCode: this.terminalExitCode, signal: null }
      }),
      kill: async () => {
        this.killedTerminals.push(id)
        finish()
        return {}
      },
      release: async () => {
        this.releasedTerminals.push(id)
        return {}
      }
    }
  }

  nextPermissionResponse: { outcome: { outcome: 'selected'; optionId: string } | { outcome: 'cancelled' } } = {
    outcome: { outcome: 'selected', optionId: 'allow' }
  }

  async sessionUpdate(msg: SessionUpdateMsg): Promise<void> {
    this.updates.push(msg)
  }

  async requestPermission(
    params: unknown
  ): Promise<{ outcome: { outcome: 'selected'; optionId: string } | { outcome: 'cancelled' } }> {
    this.permissionRequests.push(params)
    return this.nextPermissionResponse
  }
}

export class FakePiRpcProcess {
  private handlers: Array<(ev: PiRpcEvent) => void> = []

  // spies
  readonly prompts: Array<{ message: string; attachments: unknown[] }> = []
  readonly extensionUiResponses: unknown[] = []
  readonly thinkingLevels: ThinkingLevel[] = []
  abortCount = 0

  private thinkingLevel: ThinkingLevel | null = null

  onEvent(handler: (ev: PiRpcEvent) => void): () => void {
    this.handlers.push(handler)
    return () => {
      this.handlers = this.handlers.filter(h => h !== handler)
    }
  }

  emit(ev: PiRpcEvent) {
    for (const h of this.handlers) h(ev)
  }

  async prompt(message: string, attachments: unknown[] = []): Promise<void> {
    this.prompts.push({ message, attachments })
  }

  async abort(): Promise<void> {
    this.abortCount += 1
  }

  async sendExtensionUiResponse(response: unknown): Promise<void> {
    this.extensionUiResponses.push(response)
  }

  async getState(): Promise<any> {
    return {}
  }

  async setThinkingLevel(level: ThinkingLevel): Promise<void> {
    this.thinkingLevels.push(level)
    this.thinkingLevel = level
  }

  getThinkingLevel(): ThinkingLevel | null {
    return this.thinkingLevel
  }

  seedThinkingLevel(level: ThinkingLevel): void {
    if (this.thinkingLevel === null) this.thinkingLevel = level
  }

  async getAvailableModels(): Promise<any> {
    return { models: [{ provider: 'test', id: 'model', name: 'model' }] }
  }

  async getMessages(): Promise<any> {
    return { messages: [] }
  }
}

/**
 * Thinking-level cache for ad-hoc `proc` doubles, mirroring PiRpcProcess. Real pi never
 * reports the level back through `get_state`, so doubles must not either — otherwise they
 * are more consistent than production and hide read-after-write bugs.
 */
export function fakeThinkingLevelCache(spy?: ThinkingLevel[]) {
  let level: ThinkingLevel | null = null
  return {
    async setThinkingLevel(next: ThinkingLevel): Promise<void> {
      spy?.push(next)
      level = next
    },
    getThinkingLevel(): ThinkingLevel | null {
      return level
    },
    seedThinkingLevel(next: ThinkingLevel): void {
      if (level === null) level = next
    }
  }
}

export function asAgentConn(conn: FakeAgentSideConnection): AgentSideConnection {
  // We only implement the method(s) used by PiAcpSession in tests.
  return conn as unknown as AgentSideConnection
}
