import path from "node:path";

export function databasePathFor(env: NodeJS.ProcessEnv): string {
  const mount = env.RAILWAY_VOLUME_MOUNT_PATH;
  const databasePath = env.DATABASE_PATH || (mount ? path.join(mount, "crazyland.db") : "./data/crazyland.db");
  if (mount) {
    const relative = path.relative(path.resolve(mount), path.resolve(databasePath));
    if (!relative || relative === ".." || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) {
      throw new Error("DATABASE_PATH must point to a file inside RAILWAY_VOLUME_MOUNT_PATH so bot data survives deployments");
    }
  }
  return databasePath;
}
