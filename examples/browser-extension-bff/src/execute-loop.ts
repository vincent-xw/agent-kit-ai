import type { HarnessResult } from '@agentkit-ai/core'
import type { EventBus } from './event-bus.js'

export interface ExecuteLoop {
  dispatchResult(result: HarnessResult, sessionId: string): void
}

export function createExecuteLoop(bus: EventBus): ExecuteLoop {
  return {
    dispatchResult(result, sessionId) {
      if (result.type === 'pending_tool_calls') {
        for (const call of result.calls) {
          bus.emit({
            type: 'tool_call',
            callId: call.callId,
            toolName: call.toolName,
            input: call.input,
            sessionId,
          })
        }
        return
      }
      if (result.type === 'final') {
        bus.emit({
          type: 'final',
          output: result.output,
          ...(result.reasoning ? { reasoning: result.reasoning } : {}),
          sessionId,
        })
      }
      // step_done is not used in the remote-tool flow; ignore.
    },
  }
}
