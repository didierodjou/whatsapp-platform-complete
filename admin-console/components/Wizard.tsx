"use client";

import React, { useEffect, useState } from "react";
import {
  Check, ChevronRight, ChevronLeft, Store, UtensilsCrossed, Building2,
  Dumbbell, Stethoscope, CircleCheck, Phone, Zap, ExternalLink, Loader2,
} from "lucide-react";
import { SectorProfile, ClientDetail, SECTOR_ACCENTS, SECTOR_LABELS, CreateClientResponse } from "@/lib/types";

const SECTOR_ICONS: Record<string, any> = {
  restaurant: UtensilsCrossed,
  boutique: Store,
  immobilier: Building2,
  sport: Dumbbell,
  dentaire: Stethoscope,
};

const STEPS = ["Secteur", "Identité", "Config WhatsApp", "Récapitulatif"];

interface Props {
  prefill: ClientDetail | null;
  editing?: boolean;
  onCancel: () => void;
  onCreated: () => void;
}

export default function Wizard({ prefill, editing = false, onCancel, onCreated }: Props) {
  const [step, setStep] = useState(0);
  const [sectors, setSectors] = useState<SectorProfile[]>([]);
  const [loadingSectors, setLoadingSectors] = useState(true);
  const [sectorId, setSectorId] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [result, setResult] = useState<CreateClientResponse | null>(null);

  const [form, setForm] = useState({
    nom: prefill ? (editing ? prefill.nomEntreprise : prefill.nomEntreprise + " (copie)") : "",
    numero: prefill && editing ? prefill.numero : "",
    numeroId: prefill && editing ? prefill.whatsappPhoneNumberId ?? "" : "",
    horaires: prefill?.variablesPrompt?.horaires ?? "",
    tarifs: prefill?.variablesPrompt?.tarifs ?? "",
  });

  useEffect(() => {
    fetch("/api/sectors")
      .then((r) => r.json())
      .then((data: SectorProfile[]) => {
        setSectors(data);
        if (prefill) {
          const match = data.find((s) => s.nomSecteur === prefill.secteur);
          if (match) setSectorId(match.id);
        }
        setLoadingSectors(false);
      })
      .catch(() => setLoadingSectors(false));
  }, [prefill]);

  const sector = sectors.find((s) => s.id === sectorId);
  const canNext =
    (step === 0 && sectorId) ||
    (step === 1 && form.nom.trim().length > 1) ||
    (step === 2 && form.numero.trim().length > 5) ||
    step === 3;

  const set = (k: keyof typeof form) => (e: React.ChangeEvent<HTMLInputElement | HTMLTextAreaElement>) =>
    setForm((f) => ({ ...f, [k]: e.target.value }));

  async function handleCreate() {
    if (!sector) return;
    setSubmitting(true);
    setError(null);
    try {
      const res = await fetch(editing && prefill ? `/api/clients/${prefill.id}` : "/api/clients", {
        method: editing ? "PATCH" : "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          secteur: sector.nomSecteur,
          nom_entreprise: form.nom,
          whatsapp_business_number: form.numero,
          whatsapp_phone_number_id: form.numeroId || undefined,
          variables_prompt: { horaires: form.horaires, tarifs: form.tarifs },
        }),
      });
      const data = await res.json();
      if (!res.ok) {
        setError(data?.error ? JSON.stringify(data.error) : "Échec de la création du client.");
        setSubmitting(false);
        return;
      }
      setResult(editing ? { checklist_restante: [], lien_oauth_calendar: "" } : data);
      onCreated();
    } catch (e) {
      setError("Impossible de joindre le backend. Vérifie que BACKEND_URL est démarré.");
    } finally {
      setSubmitting(false);
    }
  }

  // Écran de succès avec checklist réelle
  if (result) {
    return (
      <div className="flex flex-col items-center justify-center h-full px-8 text-center">
        <div className="w-12 h-12 rounded-full flex items-center justify-center mb-4" style={{ background: "#1F6F5C" }}>
          <Check size={22} color="#EDF3EF" />
        </div>
        <h2 className="text-[19px] font-semibold text-[#EDF3EF] mb-1">{editing ? "Client modifié" : "Client créé"}</h2>
        <p className="text-[13px] text-[#8A928D] mb-6 max-w-sm">
          « {form.nom} » {editing ? "a été mis à jour." : "est en base. Termine ces étapes manuelles pour l'activer complètement :"}
        </p>
        {!editing && <div className="w-full max-w-md rounded-lg overflow-hidden text-left" style={{ border: "1px solid #2B302C" }}>
          {result.checklist_restante.map((item, i) => (
            <div key={i} className="px-4 py-3 text-[12.5px] text-[#B7BEB8] flex items-start gap-2.5" style={{ borderBottom: i < result.checklist_restante.length - 1 ? "1px solid #2B302C" : "none" }}>
              <span className="text-[#6B7268] font-mono text-[11px] mt-0.5">{String(i + 1).padStart(2, "0")}</span>
              <span>{item}</span>
            </div>
          ))}
        </div>}
        {!editing && <a
          href={result.lien_oauth_calendar}
          target="_blank"
          rel="noreferrer"
          className="flex items-center gap-1.5 text-[12.5px] font-medium mt-5 px-3.5 py-2 rounded-md"
          style={{ background: "#1F6F5C", color: "#EDF3EF" }}
        >
          Connecter Google Calendar maintenant
          <ExternalLink size={13} />
        </a>}
        <button onClick={onCancel} className="text-[12.5px] text-[#8A928D] hover:text-[#EDF3EF] mt-4">
          Retour au dashboard
        </button>
      </div>
    );
  }

  return (
    <div className="flex flex-col h-full">
      <div className="flex items-center gap-0 px-8 pt-7 pb-6">
        {STEPS.map((label, i) => (
          <React.Fragment key={label}>
            <div className="flex items-center gap-2.5">
              <div
                className="w-6 h-6 rounded-full flex items-center justify-center text-[11px] font-mono transition-colors"
                style={{
                  background: i <= step ? "#1F6F5C" : "transparent",
                  border: `1px solid ${i <= step ? "#1F6F5C" : "#3A3F3B"}`,
                  color: i <= step ? "#EDF3EF" : "#7A827D",
                }}
              >
                {i < step ? <Check size={12} /> : i + 1}
              </div>
              <span className="text-[13px] font-medium hidden sm:block" style={{ color: i === step ? "#EDF3EF" : "#7A827D" }}>
                {label}
              </span>
            </div>
            {i < STEPS.length - 1 && (
              <div className="h-px flex-1 mx-3" style={{ background: i < step ? "#1F6F5C" : "#2B302C" }} />
            )}
          </React.Fragment>
        ))}
      </div>

      <div className="flex-1 overflow-y-auto px-8 pb-4">
        {step === 0 && (
          <div>
            <h2 className="text-[19px] font-semibold text-[#EDF3EF] mb-1">Choisir un profil sectoriel</h2>
            <p className="text-[13px] text-[#8A928D] mb-6">
              Chargé en direct depuis <code className="text-[11px]">sector_profiles</code> — ajouter un secteur en base l'affiche ici sans redéploiement.
            </p>
            {loadingSectors ? (
              <div className="flex items-center gap-2 text-[#8A928D] text-[13px]">
                <Loader2 size={15} className="animate-spin" /> Chargement des profils...
              </div>
            ) : (
              <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
                {sectors.map((s) => {
                  const Icon = SECTOR_ICONS[s.nomSecteur] ?? Store;
                  const accent = SECTOR_ACCENTS[s.nomSecteur] ?? "#8A928D";
                  const active = sectorId === s.id;
                  return (
                    <button
                      key={s.id}
                      onClick={() => setSectorId(s.id)}
                      className="text-left rounded-lg p-4 transition-all"
                      style={{
                        background: active ? "#171B18" : "transparent",
                        border: `1px solid ${active ? accent : "#2B302C"}`,
                        boxShadow: active ? `0 0 0 1px ${accent}22` : "none",
                      }}
                    >
                      <div className="flex items-start justify-between mb-3">
                        <div className="w-8 h-8 rounded-md flex items-center justify-center" style={{ background: `${accent}1A` }}>
                          <Icon size={16} style={{ color: accent }} />
                        </div>
                        {active && <CircleCheck size={17} style={{ color: accent }} />}
                      </div>
                      <div className="text-[14px] font-medium text-[#EDF3EF]">
                        {SECTOR_LABELS[s.nomSecteur] ?? s.nomSecteur}
                      </div>
                      <div className="text-[12px] text-[#8A928D] mt-0.5">{s.tonParDefaut}</div>
                      <div className="flex flex-wrap gap-1.5 mt-3">
                        {Object.entries(s.workflowsActifs)
                          .filter(([, v]) => v)
                          .map(([w]) => (
                            <span key={w} className="text-[10px] px-1.5 py-0.5 rounded font-mono" style={{ background: "#1D2220", color: "#8A928D" }}>
                              {w}
                            </span>
                          ))}
                      </div>
                    </button>
                  );
                })}
              </div>
            )}
          </div>
        )}

        {step === 1 && sector && (
          <div className="max-w-md">
            <h2 className="text-[19px] font-semibold text-[#EDF3EF] mb-1">Identité du client</h2>
            <p className="text-[13px] text-[#8A928D] mb-6">
              Ces valeurs remplissent le template du secteur « {SECTOR_LABELS[sector.nomSecteur]} ».
            </p>
            <Field label="Nom de l'entreprise" value={form.nom} onChange={set("nom")} placeholder="Ex. Chez Amara" />
            <Field label="Horaires" value={form.horaires} onChange={set("horaires")} placeholder="Lun-Sam 11h-22h" />
            <Field label="Tarifs / offre (résumé)" value={form.tarifs} onChange={set("tarifs")} placeholder="Menu du jour 3500 FCFA..." textarea />
          </div>
        )}

        {step === 2 && (
          <div className="max-w-md">
            <h2 className="text-[19px] font-semibold text-[#EDF3EF] mb-1">Numéro WhatsApp Business</h2>
            <p className="text-[13px] text-[#8A928D] mb-6">
              Ce numéro identifie le client à chaque message entrant.
            </p>
            <Field label="Numéro affiché (whatsapp_business_number)" value={form.numero} onChange={set("numero")} placeholder="+225 07 XX XX XX" icon={Phone} />
            <Field label="Phone Number ID Meta" value={form.numeroId} onChange={set("numeroId")} placeholder="1234567890" />
            <div className="rounded-md p-3 mt-4 flex gap-2.5" style={{ background: "#1D2220", border: "1px solid #2B302C" }}>
              <Zap size={14} className="text-[#E8A33D] mt-0.5 shrink-0" />
              <p className="text-[12px] text-[#8A928D] leading-relaxed">
                Après création, un lien de connexion Google Calendar réel (OAuth2) s'affichera — cliquable immédiatement.
              </p>
            </div>
          </div>
        )}

        {step === 3 && sector && (
          <div className="max-w-lg">
            <h2 className="text-[19px] font-semibold text-[#EDF3EF] mb-1">Récapitulatif</h2>
            <p className="text-[13px] text-[#8A928D] mb-6">Vérifie avant de créer le client.</p>
            <div className="rounded-lg overflow-hidden" style={{ border: "1px solid #2B302C" }}>
              <SummaryRow label="Secteur" value={SECTOR_LABELS[sector.nomSecteur] ?? sector.nomSecteur} />
              <SummaryRow label="Entreprise" value={form.nom || "—"} />
              <SummaryRow label="Numéro WhatsApp" value={form.numero || "—"} />
              <SummaryRow label="Horaires" value={form.horaires || "—"} />
              <SummaryRow label="Ton par défaut" value={sector.tonParDefaut} last />
            </div>
            {error && (
              <div className="mt-4 text-[12.5px] px-3 py-2.5 rounded-md" style={{ background: "#2A1414", color: "#E8888A", border: "1px solid #4A2020" }}>
                {error}
              </div>
            )}
          </div>
        )}
      </div>

      <div className="flex items-center justify-between px-8 py-5" style={{ borderTop: "1px solid #2B302C" }}>
        <button
          onClick={() => (step === 0 ? onCancel() : setStep((s) => s - 1))}
          className="flex items-center gap-1.5 text-[13px] text-[#8A928D] hover:text-[#EDF3EF] transition-colors"
        >
          <ChevronLeft size={15} />
          {step === 0 ? "Annuler" : "Retour"}
        </button>
        <button
          disabled={!canNext || submitting}
          onClick={() => (step === 3 ? handleCreate() : setStep((s) => s + 1))}
          className="flex items-center gap-1.5 text-[13px] font-medium px-4 py-2 rounded-md transition-all disabled:opacity-30 disabled:cursor-not-allowed"
          style={{ background: "#1F6F5C", color: "#EDF3EF" }}
        >
          {submitting ? <Loader2 size={14} className="animate-spin" /> : null}
          {step === 3 ? (submitting ? "Enregistrement..." : editing ? "Enregistrer les modifications" : "Créer le client") : "Continuer"}
          {!submitting && <ChevronRight size={15} />}
        </button>
      </div>
    </div>
  );
}

function Field({
  label, value, onChange, placeholder, textarea, icon: Icon,
}: {
  label: string; value: string; onChange: (e: any) => void; placeholder?: string; textarea?: boolean; icon?: any;
}) {
  const Comp: any = textarea ? "textarea" : "input";
  return (
    <div className="mb-4">
      <label className="text-[12px] font-medium text-[#B7BEB8] mb-1.5 block">{label}</label>
      <div className="relative">
        {Icon && <Icon size={14} className="absolute left-3 top-1/2 -translate-y-1/2 text-[#6B7268]" />}
        <Comp
          value={value}
          onChange={onChange}
          placeholder={placeholder}
          rows={textarea ? 3 : undefined}
          className="w-full text-[13px] rounded-md px-3 py-2.5 outline-none transition-colors resize-none bg-transparent"
          style={{ border: "1px solid #2B302C", color: "#EDF3EF", paddingLeft: Icon ? "32px" : "12px" }}
          onFocus={(e: any) => (e.target.style.borderColor = "#1F6F5C")}
          onBlur={(e: any) => (e.target.style.borderColor = "#2B302C")}
        />
      </div>
    </div>
  );
}

function SummaryRow({ label, value, last }: { label: string; value: string; last?: boolean }) {
  return (
    <div className="flex items-center justify-between px-4 py-3" style={{ borderBottom: last ? "none" : "1px solid #2B302C" }}>
      <span className="text-[12px] text-[#8A928D] font-mono">{label}</span>
      <span className="text-[13px] text-[#EDF3EF] font-medium">{value}</span>
    </div>
  );
}
