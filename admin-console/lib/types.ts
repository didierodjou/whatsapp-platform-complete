export interface SectorProfile {
  id: string;
  nomSecteur: string;
  workflowsActifs: Record<string, boolean>;
  champsRdv: string[];
  tonParDefaut: string;
}

export interface ClientSummary {
  id: string;
  nomEntreprise: string;
  numero: string;
  statut: "actif" | "onboarding" | "suspendu";
  secteur: string;
  createdAt: string;
}

export interface ClientDetail {
  id: string;
  nomEntreprise: string;
  numero: string;
  whatsappPhoneNumberId: string | null;
  variablesPrompt: Record<string, string>;
  statut: string;
  secteur: string;
  hubspotConnecte: boolean;
  calendarConnecte: boolean;
}

export interface CreateClientResponse {
  client_id: string;
  checklist_restante: string[];
  lien_oauth_calendar: string;
}

export const SECTOR_ACCENTS: Record<string, string> = {
  restaurant: "#E8A33D",
  boutique: "#4D8FE8",
  immobilier: "#6B7A99",
  sport: "#E8555A",
  dentaire: "#3DBE8B",
};

export const SECTOR_LABELS: Record<string, string> = {
  restaurant: "Restaurant",
  boutique: "Boutique en ligne",
  immobilier: "Agence immobilière",
  sport: "Salle de sport",
  dentaire: "Clinique dentaire",
};

export const STATUT_LABELS: Record<string, { label: string; dot: string }> = {
  actif: { label: "Actif", dot: "#3DBE8B" },
  onboarding: { label: "Onboarding", dot: "#E8A33D" },
  suspendu: { label: "Suspendu", dot: "#6B7280" },
};
