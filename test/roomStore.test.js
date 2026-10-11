import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createRoomStore } from '../src/store/roomStore.js';

function tmpStore(roomId = 'r1') {
  const dir = mkdtempSync(join(tmpdir(), 'agent-chat-'));
  return createRoomStore({ dataDir: dir, roomId });
}

test('消息追加后可原样读回（JSONL 往返）', () => {
  const store = tmpStore();
  store.append({ id: '1', speakerName: '甲', content: '第一条' });
  store.append({ id: '2', speakerName: '乙', content: '第二条' });
  const loaded = store.load();
  assert.equal(loaded.length, 2);
  assert.equal(loaded[1].content, '第二条');
});

test('空目录与空文件都返回空历史', () => {
  assert.deepEqual(tmpStore().load(), []);
});

test('损坏的行被跳过而非让整个历史不可读', () => {
  const store = tmpStore();
  store.append({ id: '1', speakerName: '甲', content: '好的' });
  writeFileSync(store.file, `${readFileSync(store.file, 'utf8')}{坏行\n`);
  const loaded = store.load();
  assert.equal(loaded.length, 1);
  assert.equal(loaded[0].content, '好的');
});

test('reset 清空历史文件', () => {
  const store = tmpStore();
  store.append({ id: '1', speakerName: '甲', content: 'x' });
  store.reset();
  assert.deepEqual(store.load(), []);
});
