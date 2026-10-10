"use client";

import React, { useEffect, useState, useCallback } from "react";
import {
  MessageSquare, Plus, Copy, Pencil, Search, Layers, Circle, Radio, X, Loader2, AlertTriangle,
  Archive, ArchiveRestore, Trash2, Check,
} from "lucide-react";
import Wizard from "@/components/Wizard";
import { ClientSummary, ClientDetail, SECTOR_ACCENTS, SECTOR_LABELS, STATUT_LABELS } from "@/lib/types";
import {
  Store, UtensilsCrossed, Building2, Dumbbell, Stethoscope,
} from "lucide-react";

const SECTOR_ICONS: Record<string, any> = {
  restaurant: UtensilsCrossed,
  boutique: Store,
  immobilier: Building2,
  sport: Dumbbell,
  dentaire: Stethoscope,
};

export default function DashboardPage() {
  const [view, setView] = useState<"dashboard" | "wizard">("dashboard");
  const [clients, setClients] = useState<ClientSummary[]>([]);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [query, setQuery] = useState("");
  const [duplicateFrom, setDuplicateFrom] = useState<ClientDetail | null>(null);
  const [editingClient, setEditingClient] = useState<ClientDetail | null>(null);
  const [loadingDuplicate, setLoadingDuplicate] = useState<string | null>(null);
  const [busyId, setBusyId] = useState<string | null>(null);
  const [confirmDelete, setConfirmDelete] = useState<ClientSummary | null>(null);
  const [deleting, setDeleting] = useState(false);
  const [toast, setToast] = useState<string | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);

  const loadClients = useCallback(async (q = "") => {
    setLoading(true);
    setLoadError(null);
    try {
      const res = await fetch(`/api/clients?q=${encodeURIComponent(q)}`);
      const data = await res.json();
      if (!res.ok) throw new Error(data?.error ?? "Erreur inconnue");
      setClients(data);
    } catch (e: any) {
      setLoadError(
        "Impossible de joindre le backend. Vérifie que le serveur whatsapp-agent tourne et que BACKEND_URL/BACKEND_ADMIN_KEY sont corrects."
      );
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    loadClients();
  }, [loadClients]);

  useEffect(() => {
    const t = setTimeout(() => loadClients(query), 300);
    return () => clearTimeout(t);
  }, [query, loadClients]);

  async function openDuplicate(clientId: string) {
    setLoadingDuplicate(clientId);
    try {
      const res = await fetch(`/api/clients/${clientId}`);
      const data: ClientDetail = await res.json();
      setDuplicateFrom(data);
      setView("wizard");
    } finally {
      setLoadingDuplicate(null);
    }
  }

  /**
   * Archivage = statut "suspendu" : l'agent cesse de répondre pour ce client,
   * mais contacts, conversations et base de connaissance sont conservés.
   * Réversible à tout moment (retour en "actif").
   */
  async function toggleArchive(c: ClientSummary) {
    setBusyId(c.id);
    setActionError(null);
    const versSuspendu = c.statut !== "suspendu";
    try {
      const res = await fetch(`/api/clients/${c.id}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ statut: versSuspendu ? "suspendu" : "actif" }),
      });
      if (!res.ok) throw new Error();
      setToast(
        versSuspendu
          ? `« ${c.nomEntreprise} » archivé — l'agent ne répond plus pour ce client.`
          : `« ${c.nomEntreprise} » réactivé.`
      );
      await loadClients(query);
    } catch {
      setActionError(`Impossible de modifier le statut de « ${c.nomEntreprise} ».`);
    } finally {
      setBusyId(null);
    }
  }

  async function deleteClient() {
    if (!confirmDelete) return;
    setDeleting(true);
    setActionError(null);
    try {
      const res = await fetch(`/api/clients/${confirmDelete.id}`, { method: "DELETE" });
      const data = await res.json();
      if (!res.ok) throw new Error(data?.error ?? "");
      const d = data.donnees_supprimees;
      setToast(
        `« ${data.nom_entreprise} » supprimé — ${d.contacts} contact(s), ${d.conversations} message(s), ` +
          `${d.rendez_vous} RDV et ${d.chunks} fiche(s) de connaissance effacés.`
      );
      setConfirmDelete(null);
      await loadClients(query);
    } catch (e: any) {
      setActionError(`Échec de la suppression : ${e?.message || "erreur inconnue"}`);
    } finally {
      setDeleting(false);
    }
  }

  useEffect(() => {
    if (!toast) return;
    const t = setTimeout(() => setToast(null), 6000);
    return () => clearTimeout(t);
  }, [toast]);

  async function openEdit(clientId: string) {
    setLoadingDuplicate(clientId);
    try {
      const res = await fetch(`/api/clients/${clientId}`);
      const data: ClientDetail = await res.json();
      if (!res.ok) throw new Error(data as unknown as string);
      setEditingClient(data);
      setDuplicateFrom(null);
      setView("wizard");
    } finally {
      setLoadingDuplicate(null);
    }
  }

  return (
    <div className="w-full min-h-screen flex" style={{ background: "#0F1210" }}>
      {/* sidebar */}
      <div className="w-56 shrink-0 flex flex-col" style={{ borderRight: "1px solid #2B302C" }}>
        <div className="flex items-center gap-2 px-5 py-5">
          <div className="w-7 h-7 rounded-md flex items-center justify-center" style={{ background: "#1F6F5C" }}>
            <MessageSquare size={14} color="#EDF3EF" />
          </div>
          <span className="text-[14px] font-semibold text-[#EDF3EF] tracking-tight">Agentwa</span>
        </div>
        <div className="px-3 mt-2 flex flex-col gap-0.5">
          <NavItem icon={Layers} label="Clients" active={view === "dashboard"} onClick={() => setView("dashboard")} />
          <NavItem icon={Circle} label="Profils sectoriels" muted />
          <NavItem icon={Radio} label="Diffusions" muted />
        </div>
        <div className="mt-auto px-5 py-4" style={{ borderTop: "1px solid #2B302C" }}>
          <div className="text-[11px] font-mono text-[#6B7268]">HK STUDIO</div>
          <div className="text-[11px] text-[#6B7268] mt-0.5">{clients.length} clients connectés</div>
        </div>
      </div>

      {/* main */}
      <div className="flex-1 flex flex-col relative min-h-screen">
        {view === "dashboard" ? (
          <>
            <div className="flex items-center justify-between px-8 pt-7 pb-5">
              <div>
                <h1 className="text-[20px] font-semibold text-[#EDF3EF]">Clients</h1>
                <p className="text-[13px] text-[#8A928D] mt-0.5">
                  Un moteur, cinq secteurs, une config par entreprise.
                </p>
              </div>
              <button
                onClick={() => { setDuplicateFrom(null); setEditingClient(null); setView("wizard"); }}
                className="flex items-center gap-1.5 text-[13px] font-medium px-3.5 py-2 rounded-md"
                style={{ background: "#1F6F5C", color: "#EDF3EF" }}
              >
                <Plus size={15} />
                Nouveau client
              </button>
            </div>

            <div className="px-8 mb-4">
              <div className="relative max-w-xs">
                <Search size={13} className="absolute left-3 top-1/2 -translate-y-1/2 text-[#6B7268]" />
                <input
                  value={query}
                  onChange={(e) => setQuery(e.target.value)}
                  placeholder="Rechercher un client..."
                  className="w-full text-[12.5px] rounded-md pl-8 pr-3 py-2 outline-none bg-transparent"
                  style={{ border: "1px solid #2B302C", color: "#EDF3EF" }}
                />
              </div>
            </div>

            <div className="flex-1 px-8 pb-8">
              {loadError && (
                <div className="flex items-start gap-2.5 rounded-md px-4 py-3 mb-4 text-[12.5px]" style={{ background: "#2A1414", border: "1px solid #4A2020", color: "#E8888A" }}>
                  <AlertTriangle size={15} className="mt-0.5 shrink-0" />
                  {loadError}
                </div>
              )}

              {actionError && (
                <div className="flex items-start gap-2.5 rounded-md px-4 py-3 mb-4 text-[12.5px]" style={{ background: "#2A1414", border: "1px solid #4A2020", color: "#E8888A" }}>
                  <AlertTriangle size={15} className="mt-0.5 shrink-0" />
                  {actionError}
                </div>
              )}

              {toast && (
                <div className="flex items-start gap-2.5 rounded-md px-4 py-3 mb-4 text-[12.5px]" style={{ background: "#13221D", border: "1px solid #1F6F5C", color: "#9FD6C4" }}>
                  <Check size={15} className="mt-0.5 shrink-0" />
                  {toast}
                </div>
              )}

              {loading ? (
                <div className="flex items-center gap-2 text-[#8A928D] text-[13px] py-8">
                  <Loader2 size={15} className="animate-spin" /> Chargement des clients...
                </div>
              ) : (
                <div className="grid grid-cols-1 gap-2.5">
                  {clients.map((c) => {
                    const accent = SECTOR_ACCENTS[c.secteur] ?? "#8A928D";
                    const Icon = SECTOR_ICONS[c.secteur] ?? Store;
                    const st = STATUT_LABELS[c.statut] ?? { label: c.statut, dot: "#6B7280" };
                    return (
                      <div
                        key={c.id}
                        className="flex items-center justify-between rounded-lg px-4 py-3.5 group"
                        style={{ border: "1px solid #2B302C" }}
                      >
                        <div className="flex items-center gap-3.5 min-w-0">
                          <div className="w-9 h-9 rounded-md flex items-center justify-center shrink-0" style={{ background: `${accent}1A` }}>
                            <Icon size={16} style={{ color: accent }} />
                          </div>
                          <div className="min-w-0">
                            <div className="text-[13.5px] font-medium text-[#EDF3EF] truncate">{c.nomEntreprise}</div>
                            <div className="flex items-center gap-2 mt-0.5">
                              <span className="text-[11.5px] text-[#8A928D] font-mono">{SECTOR_LABELS[c.secteur] ?? c.secteur}</span>
                              <span className="text-[#3A3F3B]">·</span>
                              <span className="text-[11.5px] text-[#8A928D]">{c.numero}</span>
                            </div>
                          </div>
                        </div>
                        <div className="flex items-center gap-4 shrink-0">
                          <div className="flex items-center gap-1.5">
                            <span className="w-1.5 h-1.5 rounded-full" style={{ background: st.dot }} />
                            <span className="text-[11.5px] text-[#8A928D]">{st.label}</span>
                          </div>
                          <button
                            onClick={() => openEdit(c.id)}
                            disabled={loadingDuplicate === c.id}
                            title="Modifier les paramètres"
                            className="flex items-center gap-1 text-[12px] text-[#8A928D] hover:text-[#EDF3EF] opacity-0 group-hover:opacity-100 transition-opacity px-2 py-1 rounded"
                          >
                            <Pencil size={12} />
                            Modifier
                          </button>
                          <button
                            onClick={() => openDuplicate(c.id)}
                            disabled={loadingDuplicate === c.id}
                            className="flex items-center gap-1 text-[12px] text-[#8A928D] hover:text-[#EDF3EF] opacity-0 group-hover:opacity-100 transition-opacity px-2 py-1 rounded"
                          >
                            {loadingDuplicate === c.id ? <Loader2 size={12} className="animate-spin" /> : <Copy size={12} />}
                            Dupliquer
                          </button>
                          <button
                            onClick={() => toggleArchive(c)}
                            disabled={busyId === c.id}
                            title={
                              c.statut === "suspendu"
                                ? "Réactiver : l'agent répondra de nouveau"
                                : "Archiver : l'agent cesse de répondre, les données sont conservées"
                            }
                            className="flex items-center gap-1 text-[12px] text-[#8A928D] hover:text-[#EDF3EF] opacity-0 group-hover:opacity-100 transition-opacity px-2 py-1 rounded"
                          >
                            {busyId === c.id ? (
                              <Loader2 size={12} className="animate-spin" />
                            ) : c.statut === "suspendu" ? (
                              <ArchiveRestore size={12} />
                            ) : (
                              <Archive size={12} />
                            )}
                            {c.statut === "suspendu" ? "Réactiver" : "Archiver"}
                          </button>
                          <button
                            onClick={() => setConfirmDelete(c)}
                            title="Supprimer définitivement le client et toutes ses données"
                            className="flex items-center gap-1 text-[12px] text-[#8A928D] hover:text-[#E8888A] opacity-0 group-hover:opacity-100 transition-opacity px-2 py-1 rounded"
                          >
                            <Trash2 size={12} />
                            Supprimer
                          </button>
                        </div>
                      </div>
                    );
                  })}
                  {clients.length === 0 && !loadError && (
                    <div className="text-center py-16 text-[13px] text-[#6B7268]">
                      Aucun client pour l'instant — clique sur « Nouveau client » pour commencer.
                    </div>
                  )}
                </div>
              )}
            </div>
          </>
        ) : (
          <>
            <div className="flex items-center justify-between px-8 pt-6">
              <div className="flex items-center gap-2 text-[12px] text-[#8A928D]">
                {editingClient ? (
                  <>
                    <Pencil size={12} />
                    Modification de « {editingClient.nomEntreprise} »
                  </>
                ) : duplicateFrom ? (
                  <>
                    <Copy size={12} />
                    Duplication depuis « {duplicateFrom.nomEntreprise} »
                  </>
                ) : (
                  <>
                    <Plus size={12} />
                    Nouvel onboarding
                  </>
                )}
              </div>
              <button onClick={() => setView("dashboard")} className="text-[#6B7268] hover:text-[#EDF3EF]">
                <X size={16} />
              </button>
            </div>
            <div className="flex-1">
              <Wizard
                prefill={editingClient ?? duplicateFrom}
                editing={!!editingClient}
                onCancel={() => setView("dashboard")}
                onCreated={() => loadClients(query)}
              />
            </div>
          </>
        )}
      </div>

      {confirmDelete && (
        <div
          className="fixed inset-0 z-50 flex items-center justify-center px-6"
          style={{ background: "rgba(8,10,9,0.72)" }}
          onClick={() => !deleting && setConfirmDelete(null)}
        >
          <div
            className="w-full max-w-md rounded-lg p-6"
            style={{ background: "#121613", border: "1px solid #2B302C" }}
            onClick={(e) => e.stopPropagation()}
          >
            <div className="flex items-start gap-3">
              <div className="w-9 h-9 rounded-md flex items-center justify-center shrink-0" style={{ background: "#2A1414" }}>
                <Trash2 size={16} color="#E8888A" />
              </div>
              <div className="min-w-0">
                <h2 className="text-[15px] font-semibold text-[#EDF3EF]">
                  Supprimer « {confirmDelete.nomEntreprise} » ?
                </h2>
                <p className="text-[12.5px] text-[#8A928D] mt-1.5 leading-relaxed">
                  Cette action est <strong className="text-[#E8888A]">irréversible</strong>. Seront
                  effacés avec le client : ses contacts, l'historique complet des conversations, les
                  rendez-vous, les relances programmées, les escalades et toute sa base de
                  connaissance.
                </p>
                <p className="text-[12.5px] text-[#8A928D] mt-2.5 leading-relaxed">
                  Pour simplement suspendre les réponses automatiques en conservant les données,
                  utilise <strong className="text-[#EDF3EF]">Archiver</strong>.
                </p>
              </div>
            </div>

            <div className="flex items-center justify-end gap-2 mt-6">
              <button
                onClick={() => setConfirmDelete(null)}
                disabled={deleting}
                className="text-[13px] px-3.5 py-2 rounded-md"
                style={{ border: "1px solid #2B302C", color: "#8A928D" }}
              >
                Annuler
              </button>
              <button
                onClick={deleteClient}
                disabled={deleting}
                className="flex items-center gap-1.5 text-[13px] font-medium px-3.5 py-2 rounded-md"
                style={{ background: "#7A2A2C", color: "#F5DADA" }}
              >
                {deleting && <Loader2 size={13} className="animate-spin" />}
                {deleting ? "Suppression..." : "Supprimer définitivement"}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

function NavItem({ icon: Icon, label, active, muted, onClick }: { icon: any; label: string; active?: boolean; muted?: boolean; onClick?: () => void }) {
  return (
    <button
      onClick={onClick}
      className="flex items-center gap-2.5 px-3 py-2 rounded-md text-[13px] transition-colors w-full text-left"
      style={{
        background: active ? "#171B18" : "transparent",
        color: active ? "#EDF3EF" : muted ? "#5A615C" : "#8A928D",
        cursor: muted ? "default" : "pointer",
      }}
    >
      <Icon size={15} />
      {label}
    </button>
  );
}
