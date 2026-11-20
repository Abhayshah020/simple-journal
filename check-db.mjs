import nextEnv from "@next/env";
import { neon } from "@neondatabase/serverless";

const { loadEnvConfig } = nextEnv;
loadEnvConfig(process.cwd());

const databaseUrl = process.env.DATABASE_URL;

if (!databaseUrl) {
  console.error("DATABASE_URL is missing.");
  console.error("Check that .env.local exists in the project root.");
  process.exit(1);
}

try {
  const sql = neon(databaseUrl);

  const database = await sql`
    SELECT
      current_database() AS database,
      current_schema() AS schema,
      current_user AS db_user
  `;

  console.log("\n========== DATABASE CONNECTION ==========");
  console.table(database);

  const tables = await sql`
    SELECT table_schema, table_name
    FROM information_schema.tables
    WHERE table_schema = 'public'
    ORDER BY table_name
  `;

  console.log("\n========== PUBLIC TABLES ==========");
  console.table(tables);
} catch (error) {
  console.error("Database check failed:", error.message);
  process.exit(1);
}