import "dotenv/config";
import fs from "fs";
import path from "path";
import { Pool } from "pg";

const pool = new Pool({ connectionString: process.env.DATABASE_URL });

async function seed() {
  const file = path.join(__dirname, "..", "seeds", "sector_profiles.sql");
  console.log("Insertion des 5 profils sectoriels...");
  await pool.query(fs.readFileSync(file, "utf-8"));
  console.log("Seed terminé.");
  await pool.end();
}

seed().catch((err) => {
  console.error("Échec seed:", err);
  process.exit(1);
});
