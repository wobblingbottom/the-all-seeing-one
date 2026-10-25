import { test } from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import { databasePathFor } from "../src/database-path.js";

test("local development keeps its existing database path", () => {
  assert.equal(databasePathFor({}), "./data/crazyland.db");
});

test("Railway defaults to persistent storage", () => {
  const mount = path.resolve("persistent-volume");
  assert.equal(databasePathFor({ RAILWAY_VOLUME_MOUNT_PATH: mount }), path.join(mount, "crazyland.db"));
  assert.equal(databasePathFor({ RAILWAY_VOLUME_MOUNT_PATH: mount, DATABASE_PATH: path.join(mount, "custom.db") }), path.join(mount, "custom.db"));
});

test("Railway rejects container paths, sibling prefixes, and the mount directory itself", () => {
  const mount = path.resolve("persistent-volume");
  for (const databasePath of ["./data/crazyland.db", path.join(mount, "..", "outside.db"), `${mount}-other/db`, mount]) {
    assert.throws(() => databasePathFor({ RAILWAY_VOLUME_MOUNT_PATH: mount, DATABASE_PATH: databasePath }), /inside RAILWAY_VOLUME_MOUNT_PATH/);
  }
});
