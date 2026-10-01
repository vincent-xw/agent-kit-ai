export interface BffEvent {
  seq: number
  ts: number
  type: string
  [key: string]: unknown
}

export interface EventBus {
  emit(event: { type: string; [key: string]: unknown }): void
  subscribe(listener: (event: BffEvent) => void, fromSeq?: number): () => void
}

export function createEventBus(options: { bufferSize?: number } = {}): EventBus {
  const bufferSize = options.bufferSize ?? 200
  const buffer: BffEvent[] = []
  const listeners = new Set<(event: BffEvent) => void>()
  let seq = 0

  return {
    emit(event) {
      seq += 1
      const full: BffEvent = { ...event, seq, ts: Date.now() }
      buffer.push(full)
      if (buffer.length > bufferSize) buffer.splice(0, buffer.length - bufferSize)
      for (const listener of listeners) listener(full)
    },
    subscribe(listener, fromSeq) {
      if (fromSeq !== undefined) {
        for (const event of buffer) {
          if (event.seq > fromSeq) listener(event)
        }
      }
      listeners.add(listener)
      return () => {
        listeners.delete(listener)
      }
    },
  }
}
