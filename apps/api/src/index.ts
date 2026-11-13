import { createDb } from "@sob/db";
import { createApp } from "./app";

const { db } = createDb();

export default {
  port: Number(process.env.PORT ?? 3000),
  fetch: createApp({ db }).fetch,
};
