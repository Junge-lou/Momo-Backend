import { defineConfig } from "drizzle-kit";

export default defineConfig({
  dialect: "sqlite",
  schema: "./src/orm/schema.ts",
  dbCredentials: {
    url: process.env.DATABASE_URL?.replace(/^file:/, "") || "./data/dev.db",
  },
});
