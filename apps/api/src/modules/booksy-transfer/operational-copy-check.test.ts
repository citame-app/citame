import { expect, test } from "bun:test";
import { user } from "@sob/db";
import { createTestDatabase } from "@sob/db/testing";
import { sql } from "drizzle-orm";
import { assertBooksyCopySource } from "./operational-copy-check";

test("operational copy refuses consultation accounts and unexpected archive namespaces", async () => {
  const source = await createTestDatabase("booksy_copy_source");
  const rollback = new Error("Revert source fixtures");
  try {
    await expect(
      source.db.transaction(async (tx) => {
        await expect(assertBooksyCopySource(tx)).rejects.toThrow("Unexpected schemas");
        await tx.execute(sql`create schema booksy_rehearsal`);
        await expect(assertBooksyCopySource(tx)).resolves.toBeUndefined();
        await tx.insert(user).values({
          id: "synthetic-review-owner",
          role: "owner",
          email: "owner@example.test",
          name: "Synthetic review owner",
        });
        await expect(assertBooksyCopySource(tx)).rejects.toThrow("access credentials");
        await tx.execute(sql`create schema unexpected_recovery_namespace`);
        await expect(assertBooksyCopySource(tx)).rejects.toThrow("Unexpected schemas");
        throw rollback;
      }),
    ).rejects.toBe(rollback);
  } finally {
    await source.close();
  }
});
