import "dotenv/config";
import readline from "readline/promises";

/**
 * Alternative en ligne de commande à POST /admin/clients — pratique pour
 * onboarder un client sans écrire de JSON à la main.
 * Usage: npm run onboard
 */
const rl = readline.createInterface({ input: process.stdin, output: process.stdout });

async function main() {
  console.log("=== Onboarding d'un nouveau client ===\n");

  const secteur = await rl.question(
    "Secteur (restaurant / boutique / immobilier / sport / dentaire) : "
  );
  const nom_entreprise = await rl.question("Nom de l'entreprise : ");
  const whatsapp_business_number = await rl.question("Numéro WhatsApp Business : ");
  const whatsapp_phone_number_id = await rl.question(
    "Phone Number ID Meta (laisser vide si pas encore connu) : "
  );
  const horaires = await rl.question("Horaires : ");
  const tarifs = await rl.question("Tarifs / offre (résumé) : ");

  rl.close();

  const baseUrl = process.env.BASE_URL ?? `http://localhost:${process.env.PORT ?? 3000}`;
  const res = await fetch(`${baseUrl}/admin/clients`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "x-admin-key": process.env.ADMIN_API_KEY ?? "",
    },
    body: JSON.stringify({
      secteur,
      nom_entreprise,
      whatsapp_business_number,
      whatsapp_phone_number_id: whatsapp_phone_number_id || undefined,
      variables_prompt: { horaires, tarifs },
    }),
  });

  const data = await res.json();
  if (!res.ok) {
    console.error("Échec de la création:", data);
    process.exit(1);
  }

  console.log("\nClient créé avec succès.");
  console.log(`ID: ${data.client_id}`);
  console.log("\nChecklist restante :");
  data.checklist_restante.forEach((step: string) => console.log(`  [ ] ${step}`));
}

main();
