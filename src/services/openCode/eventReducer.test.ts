import { describe, expect, it } from 'vitest';
import { initialStreamView, reconcileMessages, reduceOpenCodeEvent } from './eventReducer';

describe('OpenCode stream view', () => {
  it('applies live text deltas and server snapshot replaces provisional content', () => {
    const first = reduceOpenCodeEvent(initialStreamView, { kind: 'stream', event: {
      sessionId: 'ses_1', kind: 'session.text.delta', created: 1, assistantMessageId: 'msg_a', partId: 'part_1', seq: 1,
      delta: 'Hello', tool: null, error: null, status: null,
    } });
    const second = reduceOpenCodeEvent(first, { kind: 'stream', event: {
      sessionId: 'ses_1', kind: 'session.text.delta', created: 1, assistantMessageId: 'msg_a', partId: 'part_1', seq: 2,
      delta: ' world', tool: null, error: null, status: null,
    } });
    expect(second.messages[0]?.text).toBe('Hello world');
    const authoritative = [{ ...second.messages[0]!, text: 'Hello world!', completed: 2 }];
    expect(reconcileMessages(second.messages, authoritative)).toEqual(authoritative);
  });

  it('keeps a provisional assistant bubble when the authoritative snapshot lags', () => {
    const streamed = reduceOpenCodeEvent(initialStreamView, { kind: 'stream', event: {
      sessionId: 'ses_1', kind: 'session.text.delta', created: 1, assistantMessageId: 'msg_live', partId: 'p', seq: null,
      delta: 'Live', tool: null, error: null, status: null,
    } });
    expect(reconcileMessages(streamed.messages, [])).toHaveLength(1);
  });
});
