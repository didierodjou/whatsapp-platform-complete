import "dotenv/config";
import { pool } from "./src/db/pool";

async function testDB() {
  try {
    const { rows } = await pool.query(
      "SELECT nom_secteur FROM sector_profiles ORDER BY nom_secteur"
    );
    console.log("✅ Sector profiles found:");
    rows.forEach(r => console.log(`   - ${r.nom_secteur}`));
    await pool.end();
  } catch (err) {
    console.error("❌ Error:", err);
    process.exit(1);
  }
}

testDB();