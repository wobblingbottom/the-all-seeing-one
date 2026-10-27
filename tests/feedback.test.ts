import { test } from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { feedbackStore } from '../src/feedback.js';

test('feedback validates input, persists both types and keeps user IDs private', () => {
  const db = new DatabaseSync(':memory:');
  try {
    const store = feedbackStore(db);
    const user = { id: '123', username: 'Reporter' };
    for (const body of [null, {}, { type: 'other' }, { type: 'bug', title: ' ' }, { type: 'bug', title: 'x', description: ' ' }, { type: 'bug', title: 'x'.repeat(121), description: 'x' }, { type: 'bug', title: 'x', description: 'x'.repeat(4001) }]) {
      assert.throws(() => store.create(user, body));
    }
    store.create(user, { type: 'bug', title: ' Bug ', description: '<script>example</script>' }, 100_000);
    assert.throws(() => store.create(user, { type: 'suggestion', title: 'Idea', description: 'Details' }, 159_999), /wait a minute/);
    store.create(user, { type: 'suggestion', title: 'Idea', description: 'Details' }, 160_000);
    const result = feedbackStore(db).list(1);
    assert.equal(result.items.length, 2);
    assert.equal(result.items[0].type, 'suggestion');
    assert.equal(result.items[1].title, 'Bug');
    assert.equal(result.items[1].description, '<script>example</script>');
    assert.equal('user_id' in result.items[0], false);
  } finally { db.close(); }
});

test('feedback paginates newest first and bounds the final page', () => {
  const db = new DatabaseSync(':memory:');
  try {
    const store = feedbackStore(db);
    assert.deepEqual(store.list(1), { items: [], page: 1, totalPages: 1 });
    for (let i = 0; i < 23; i++) store.create({ id: String(i), username: 'User' }, { type: 'bug', title: String(i), description: 'Details' });
    assert.equal(store.list(1).items.length, 20);
    assert.equal(store.list(1).items[0].title, '22');
    assert.equal(store.list(2).items.length, 3);
    assert.equal(store.list(999).page, 2);
  } finally { db.close(); }
});
