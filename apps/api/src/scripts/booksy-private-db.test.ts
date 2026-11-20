import { expect, test } from "bun:test";
import { chmod, mkdtemp, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { refreshPrivateBooksyConnection } from "./booksy-private-db";

test("connection refresh rejects public files, other targets and connection overrides", async () => {
  const directory = await mkdtemp(join(tmpdir(), "citame-connection-test-"));
  const file = join(directory, "connection.env");
  const candidate = "sob_booksy_candidate_20261118_1234";
  const base = `postgres://citame_import:synthetic-password@127.0.0.1:5432/${candidate}`;
  const env = (url: string) => `BOOKSY_REHEARSAL_DATABASE_URL=${url}\n`;
  try {
    await writeFile(file, env(base), { mode: 0o644 });
    await chmod(file, 0o644);
    await expect(refreshPrivateBooksyConnection(file)).rejects.toThrow(
      "Expected an operator-owned private file",
    );
    await rm(file);
    for (const url of [
      base.replace("127.0.0.1", "192.0.2.2"),
      base.replace(candidate, "sob_production"),
      `${base}?host=192.0.2.2`,
    ]) {
      await writeFile(file, env(url), { mode: 0o600 });
      await expect(refreshPrivateBooksyConnection(file)).rejects.toThrow(
        "Expected a private connection to an isolated Booksy rehearsal or candidate",
      );
      expect(await Bun.file(file).text()).toBe(env(url));
      expect(await readdir(directory)).toEqual(["connection.env"]);
    }
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
