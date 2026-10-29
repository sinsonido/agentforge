import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { EMPTY_TRANSCRIPT, applyPage, receive } from '../../ui/src/lib/transcript.ts';

const ev = (seq) => ({ seq, at: seq, event: { type: 'text', text: `e${seq}` } });
const seqs = (t) => t.events.map((e) => e.seq);

describe('transcript', () => {
  it('appends contiguous live events and ignores repeats', () => {
    let t = applyPage(EMPTY_TRANSCRIPT, [ev(1), ev(2)]);
    for (const e of [ev(3), ev(2), ev(3), ev(4)]) {
      const r = receive(t, e);
      assert.equal(r.gap, false);
      t = r.transcript;
    }
    assert.deepEqual(seqs(t), [1, 2, 3, 4]);
    assert.equal(t.cursor, 4);
  });

  it('flags a gap after a reconnect and fills it from the replay without duplicates', () => {
    const before = applyPage(EMPTY_TRANSCRIPT, [ev(1), ev(2)]);
    const live = receive(before, ev(5));
    assert.equal(live.gap, true);
    assert.equal(live.transcript.cursor, 2, 'the cursor stays at the last contiguous seq');

    const filled = applyPage(live.transcript, [ev(3), ev(4), ev(5)]);
    assert.deepEqual(seqs(filled), [1, 2, 3, 4, 5]);
    assert.equal(filled.cursor, 5);
  });

  it('merges live events that arrive while a replay is in flight', () => {
    const live = receive(EMPTY_TRANSCRIPT, ev(3)).transcript;
    const t = applyPage(live, [ev(1), ev(2), ev(3)]);
    assert.deepEqual(seqs(t), [1, 2, 3]);
    assert.equal(t.cursor, 3);
  });

  it('accepts a replay that starts after pruned events and stops asking for them', () => {
    const t = applyPage(EMPTY_TRANSCRIPT, [ev(1001), ev(1002)]);
    assert.equal(t.cursor, 1002);
    assert.equal(receive(t, ev(1003)).gap, false);
  });

  it('keeps the cursor on an empty page', () => {
    const t = applyPage(applyPage(EMPTY_TRANSCRIPT, [ev(1)]), []);
    assert.equal(t.cursor, 1);
  });
});
