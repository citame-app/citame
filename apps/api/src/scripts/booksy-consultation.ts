import { randomBytes } from "node:crypto";
import { readFile, realpath } from "node:fs/promises";
import { resolve } from "node:path";
import {
  booksyDesktopTestDatabase,
  connectToNamedDatabase,
  runMigrations,
  salonSettings,
  user,
  verifyMigrationLedger,
} from "@sob/db";
import { RedisClient } from "bun";
import { eq } from "drizzle-orm";
import { createApp } from "../app";
import { createAccount } from "../auth/accounts";
import { createAuth } from "../auth/auth";
import { loadConfig } from "../config";
import { restoreLegacyBooksyPaymentEvidence } from "../modules/booksy-transfer/operational-rehearsal";
import { loadBooksySourceModel } from "../modules/booksy-transfer/source-store";
import { privateCliError, privateWrite } from "../modules/booksy-transfer/vault";

const slots = {
  archive: { apiPort: 4301, webPort: 4276, name: "consultation", cacheScope: "" },
  "--native": { apiPort: 4302, webPort: 4277, name: "native", cacheScope: "native:" },
  "--native-review": { apiPort: 4303, webPort: 4278, name: "review", cacheScope: "review:" },
  "--native-latest": { apiPort: 4304, webPort: 4279, name: "latest", cacheScope: "latest:" },
  "--desktop-test": {
    apiPort: 4305,
    webPort: 4275,
    name: "desktop-test",
    cacheScope: "desktop-test:",
  },
} as const;

/** Local import reviews and the isolated desktop test copy. No public listener or operational workers. */
if (import.meta.main) {
  let closeDatabase: (() => Promise<void>) | undefined;
  let closeCache: (() => void) | undefined;
  let closeApp: (() => Promise<void>) | undefined;
  try {
    const [directory, snapshotHash, mode = "archive", startup, ...extra] =
      process.argv.slice(2);
    const desktopTest = mode === "--desktop-test";
    const prepared =
      desktopTest &&
      (startup === "--prepared" || startup === "--check-prepared");
    if (
      extra.length ||
      !Object.hasOwn(slots, mode) ||
      (startup !== undefined && !prepared)
    )
      throw new Error("Unexpected consultation arguments");
    const native = mode !== "archive" && !desktopTest;
    const slot = slots[mode as keyof typeof slots];
    const { apiPort, webPort } = slot;
    const connection = process.env.BOOKSY_REHEARSAL_DATABASE_URL,
      cache = process.env.VALKEY_URL;
    if (!directory || !snapshotHash || !connection || !cache)
      throw new Error(
        "Expected private directory, immutable snapshot hash and private database/cache connection files",
      );
    const root = await realpath(directory),
      url = new URL(connection),
      cacheUrl = new URL(cache);
    const databasePattern = desktopTest
      ? booksyDesktopTestDatabase
      : native
        ? /^sob_booksy_candidate_\d{8}_\d+$/
        : /^sob_booksy_rehearsal_\d{8}(?:_run[1-9]\d*)?$/;
    if (
      url.hostname !== "127.0.0.1" ||
      url.username !== "citame_import" ||
      cacheUrl.hostname !== "127.0.0.1" ||
      !databasePattern.test(url.pathname.slice(1))
    )
      throw new Error("Consultation requires isolated loopback services");
    const db = await connectToNamedDatabase(connection);
    closeDatabase = db.close;
    const snapshot = await loadBooksySourceModel(db.db, snapshotHash);
    if (prepared) {
      await verifyMigrationLedger(db.db);
    } else if (desktopTest) {
      await runMigrations(db.db, { allowReviewDatabase: true });
      await restoreLegacyBooksyPaymentEvidence(db.db, snapshotHash);
    }
    const credentialFile = resolve(root, "local-owner.json");
    let credentials: { email: string; password: string; secret: string };
    try {
      credentials = JSON.parse(await readFile(credentialFile, "utf8"));
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code !== "ENOENT") throw e;
      if (prepared)
        throw new Error(
          "The prepared desktop copy is missing its local owner file",
          { cause: e },
        );
      credentials = {
        email: desktopTest ? "pruebas@citame.localhost.invalid" : "owner@citame.localhost.invalid",
        password: randomBytes(24).toString("base64url"),
        secret: randomBytes(48).toString("base64url"),
      };
      await privateWrite(credentialFile, JSON.stringify(credentials, null, 2));
    }
    const config = loadConfig({
      DATABASE_URL: connection,
      VALKEY_URL: cache,
      VALKEY_KEY_PREFIX: `booksy-consultation:${snapshot.businessId}:${slot.cacheScope}`,
      BETTER_AUTH_SECRET: credentials.secret,
      BETTER_AUTH_URL: `http://127.0.0.1:${desktopTest ? webPort : apiPort}`,
      TRUSTED_ORIGINS: `http://127.0.0.1:${webPort}`,
      AUTH_REQUIRE_EMAIL_VERIFICATION: "false",
      PAYMENT_PROVIDER: "none",
      NOTIFY_WORKER_ENABLED: "false",
      NOTIFY_EMAIL_PROVIDER: "none",
      NOTIFY_SMS_PROVIDER: "none",
      MAINTENANCE_ENABLED: "false",
    });
    const valkey = new RedisClient(cache);
    closeCache = () => valkey.close();
    config.auth.cookiePrefix = `citame-booksy-${slot.name}`;
    await valkey.send("PING", []);
    const existing = await db.db
      .select()
      .from(user)
      .where(eq(user.email, credentials.email));
    if (prepared) {
      if (existing[0]?.role !== "owner")
        throw new Error(
          "The prepared desktop copy is missing the configured owner",
        );
      const [settings] = await db.db
        .select({ id: salonSettings.id })
        .from(salonSettings);
      if (!settings)
        throw new Error("The prepared desktop copy is missing salon settings");
    } else if (!existing.length) {
      const auth = createAuth({ db: db.db, valkey, config });
      try {
        await createAccount(
          { db: db.db, auth },
          {
            ...credentials,
            name: desktopTest ? "Pruebas locales" : "Revisión de importación",
            role: "owner",
          },
        );
      } finally {
        await auth.mailer.stop();
      }
    }
    if (!prepared) {
      await db.db
        .insert(salonSettings)
        .values({
          name: `${snapshot.businessName} · Copia de Booksy`,
          timezone: "Europe/Madrid",
          slotGranularityMinutes: 5,
          minNoticeMinutes: 60,
          maxDaysAhead: 365,
          reminderFirstLeadMinutes: null,
          reminderSecondLeadMinutes: null,
        })
        .onConflictDoNothing();
      if (desktopTest && !existing.length)
        await db.db
          .update(salonSettings)
          .set({ name: `${snapshot.businessName} · Pruebas locales` });
    }
    if (startup === "--check-prepared") {
      valkey.close();
      await db.close();
      console.log(
        JSON.stringify({ status: "prepared", database: "ok", valkey: "ok" }),
      );
      process.exit(0);
    }
    const app = createApp({
      db: db.db,
      valkey,
      config,
      ...(desktopTest
        ? { paymentGateway: null, disableEmailDeliveryTest: true }
        : native
          ? {
              booksyNativePreview: {
                system: "booksy" as const,
                readOnly: true as const,
                capturedAt: snapshot.capturedAt,
                fromDate: snapshot.fromDate,
                throughDate: snapshot.throughDate,
              },
            }
          : { booksyConsultation: snapshot }),
    });
    closeApp = () => app.shutdown();
    await app.ready();
    const server = Bun.serve({
      hostname: "127.0.0.1",
      port: apiPort,
      idleTimeout: 60,
      fetch: (req, s) => {
        if (new URL(req.url).pathname === "/sync/stream") s.timeout(req, 0);
        return app.fetch(req, s);
      },
    });
    console.log(
      JSON.stringify({
        url: `http://127.0.0.1:${apiPort}`,
        web: `http://127.0.0.1:${webPort}/admin/calendar`,
        snapshotHash,
        summary: snapshot.summary,
        mode: desktopTest
          ? "isolated-desktop-test"
          : native
            ? "native-consultation"
            : "immutable-consultation",
        outboundProviders: false,
      }),
    );
    for (const signal of ["SIGINT", "SIGTERM"] as const)
      process.on(signal, () => {
        void (async () => {
          app.drain();
          await app.shutdown();
          await server.stop(true);
          valkey.close();
          await db.close();
          process.exit(0);
        })();
      });
  } catch (e) {
    console.error(privateCliError(e, "Consultation startup failed"));
    await closeApp?.().catch(() => undefined);
    closeCache?.();
    await closeDatabase?.().catch(() => undefined);
    process.exitCode = 1;
  }
}
