import { describe, expect, it } from 'vitest'
import { createEventBus } from './event-bus.js'

describe('EventBus', () => {
  it('emits events with incrementing seq and timestamp', () => {
    const bus = createEventBus()
    const received: Array<{ seq: number; type: string; ts: number }> = []
    bus.subscribe((e) => received.push({ seq: e.seq, type: e.type, ts: e.ts as number }))

    bus.emit({ type: 'a' })
    bus.emit({ type: 'b' })

    expect(received[0]!.seq).toBe(1)
    expect(received[1]!.seq).toBe(2)
    expect(received[0]!.type).toBe('a')
    expect(typeof received[0]!.ts).toBe('number')
  })

  it('replays buffered events after fromSeq on subscribe', () => {
    const bus = createEventBus()
    bus.emit({ type: 'first' })
    bus.emit({ type: 'second' })
    bus.emit({ type: 'third' })

    const received: string[] = []
    bus.subscribe((e) => received.push(e.type as string), 1)

    expect(received).toEqual(['second', 'third'])
  })

  it('unsubscribe stops further events', () => {
    const bus = createEventBus()
    const received: string[] = []
    const unsub = bus.subscribe((e) => received.push(e.type as string))
    bus.emit({ type: 'a' })
    unsub()
    bus.emit({ type: 'b' })
    expect(received).toEqual(['a'])
  })

  it('caps buffer to bufferSize', () => {
    const bus = createEventBus({ bufferSize: 2 })
    bus.emit({ type: 'a' })
    bus.emit({ type: 'b' })
    bus.emit({ type: 'c' })

    const received: string[] = []
    bus.subscribe((e) => received.push(e.type as string), 0)
    expect(received).toEqual(['b', 'c'])
  })
})
