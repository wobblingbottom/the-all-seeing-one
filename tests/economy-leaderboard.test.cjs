const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const ts = require('typescript');
const { DatabaseSync } = require('node:sqlite');

test('Discord leaderboard reads current balances and isolates the active currency', async () => {
  const db = new DatabaseSync(':memory:');
  try {
    db.exec(`CREATE TABLE economy_accounts(guild_id TEXT,user_id TEXT,username TEXT,cash INTEGER,bank INTEGER);
      CREATE TABLE economy_balances(system_id INTEGER,user_id TEXT,username TEXT,cash INTEGER,bank INTEGER);
      INSERT INTO economy_accounts VALUES('guild','old','Outdated account',99999,0);
      INSERT INTO economy_balances VALUES(2,'a','Current member',10,20),(2,'b','Second member',5,0),(3,'c','Other currency',9999,0);`);
    const source = fs.readFileSync('src/economy.ts', 'utf8');
    const start = source.indexOf('    if (!enabled(config, "leaderboardEnabled"))');
    const end = source.indexOf('\n  }', start);
    assert.ok(start >= 0 && end > start);
    let reply;
    const context = {
      db, guildId: 'guild', config: {}, sharedConfig: {}, interaction: {},
      enabled: () => true, systemsFor: () => [{ id: 2 }],
      label: (_config, _key, fallback) => fallback,
      money: (_guild, amount) => `${amount} coins`,
      replyV2: async (_interaction, _title, body) => { reply = body; }
    };
    const code = ts.transpileModule(`(async () => {${source.slice(start, end)} })()`, {
      compilerOptions: { target: ts.ScriptTarget.ES2022 }
    }).outputText;
    await vm.runInNewContext(code, context);
    assert.match(reply, /Current member.*30 coins/);
    assert.match(reply, /Second member.*5 coins/);
    assert.doesNotMatch(reply, /Outdated account|Other currency/);
  } finally { db.close(); }
});
