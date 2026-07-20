import React, { useState, useEffect, useRef, useCallback } from "react";
import { LineChart, Line, XAxis, YAxis, CartesianGrid, Tooltip, ResponsiveContainer, Dot } from "recharts";
import {
  Upload, FileText, Plus, User, TrendingUp, TrendingDown, Minus, AlertTriangle,
  CheckCircle2, X, Loader2, ChevronRight, ArrowLeft, Trash2, Sparkles, ClipboardEdit, Info,
  FileUp,
} from "lucide-react";
import * as api from "./api.js";

const STATUS_META = {
  N: { label: "Ideal", dot: "bg-emerald-500", chip: "bg-emerald-100 text-emerald-700" },
  A: { label: "Atenção", dot: "bg-amber-500", chip: "bg-amber-100 text-amber-700" },
  F: { label: "Fora do ideal", dot: "bg-red-500", chip: "bg-red-100 text-red-700" },
};

const PROFILE_COLORS = [
  { bg: "bg-emerald-100", text: "text-emerald-700" },
  { bg: "bg-blue-100", text: "text-blue-700" },
  { bg: "bg-purple-100", text: "text-purple-700" },
  { bg: "bg-pink-100", text: "text-pink-700" },
  { bg: "bg-amber-100", text: "text-amber-700" },
  { bg: "bg-teal-100", text: "text-teal-700" },
  { bg: "bg-indigo-100", text: "text-indigo-700" },
  { bg: "bg-rose-100", text: "text-rose-700" },
];

function uid() {
  return Math.random().toString(36).slice(2, 10) + Date.now().toString(36);
}
function initials(name) {
  return (name || "?").trim().split(/\s+/).slice(0, 2).map((p) => p[0]?.toUpperCase()).join("");
}
function computeScore(results) {
  const numeric = results.filter((r) => r.status === "N" || r.status === "A" || r.status === "F");
  if (!numeric.length) return null;
  const pts = numeric.reduce((sum, r) => sum + (r.status === "N" ? 1 : r.status === "A" ? 0.5 : 0), 0);
  return Math.round((100 * pts) / numeric.length);
}
function counts(results) {
  return {
    N: results.filter((r) => r.status === "N").length,
    A: results.filter((r) => r.status === "A").length,
    F: results.filter((r) => r.status === "F").length,
  };
}
function fmtDate(d) {
  if (!d) return "";
  try {
    const [y, m, day] = d.split("-");
    if (y && m && day) return `${day}/${m}/${y}`;
  } catch (e) {}
  return d;
}

export default function App() {
  const [profiles, setProfiles] = useState(null);
  const [screen, setScreen] = useState({ name: "home" });
  const [showAddProfile, setShowAddProfile] = useState(false);
  const [showImport, setShowImport] = useState(false);

  const refreshProfiles = async () => setProfiles(await api.getProfiles());

  useEffect(() => {
    refreshProfiles();
  }, []);

  const addProfile = async (name) => {
    const newProfile = await api.createProfile(name);
    setProfiles((prev) => [...(prev || []), newProfile]);
    setShowAddProfile(false);
    setScreen({ name: "profile", profileId: newProfile.id });
  };

  const removeProfile = async (id) => {
    await api.deleteProfile(id);
    setProfiles((prev) => (prev || []).filter((p) => p.id !== id));
    setScreen({ name: "home" });
  };

  if (profiles === null) {
    return (
      <div className="flex items-center justify-center py-20 text-slate-400">
        <Loader2 className="animate-spin" size={22} />
      </div>
    );
  }

  return (
    <div className="w-full max-w-3xl mx-auto px-4 py-8">
      {screen.name === "home" && (
        <HomeScreen profiles={profiles} onOpen={(id) => setScreen({ name: "profile", profileId: id })} onAdd={() => setShowAddProfile(true)} onRemove={removeProfile} onImport={() => setShowImport(true)} />
      )}
      {screen.name === "profile" && (
        <ProfileScreen profile={profiles.find((p) => p.id === screen.profileId)} onBack={() => setScreen({ name: "home" })} />
      )}
      {showAddProfile && <AddProfileModal onClose={() => setShowAddProfile(false)} onConfirm={addProfile} />}
      {showImport && <ImportModal onClose={() => setShowImport(false)} onDone={refreshProfiles} />}
    </div>
  );
}

function HomeScreen({ profiles, onOpen, onAdd, onRemove, onImport }) {
  const [confirmDelete, setConfirmDelete] = useState(null);
  return (
    <div>
      <div className="flex items-center justify-between mb-5 flex-wrap gap-2">
        <div>
          <h1 className="text-xl font-medium text-slate-900">Histórico de exames</h1>
          <p className="text-sm text-slate-500 mt-0.5">Escolha um perfil ou adicione uma nova pessoa</p>
        </div>
        <div className="flex items-center gap-2">
          <button onClick={onImport} className="flex items-center gap-1.5 border border-slate-300 text-slate-700 text-sm font-medium px-3.5 py-2 rounded-lg hover:bg-slate-50">
            <FileUp size={15} /> Importar backup
          </button>
          <button onClick={onAdd} className="flex items-center gap-1.5 bg-slate-900 text-white text-sm font-medium px-3.5 py-2 rounded-lg hover:bg-slate-800 active:scale-95 transition">
            <Plus size={16} /> Novo perfil
          </button>
        </div>
      </div>

      {profiles.length === 0 ? (
        <div className="border border-dashed border-slate-300 rounded-xl py-14 text-center text-slate-400">
          <User size={28} className="mx-auto mb-2" />
          <p className="text-sm">Nenhum perfil ainda. Crie o primeiro para começar.</p>
        </div>
      ) : (
        <div className="grid grid-cols-2 sm:grid-cols-3 gap-3">
          {profiles.map((p) => {
            const c = PROFILE_COLORS[p.colorIdx % PROFILE_COLORS.length];
            return (
              <div key={p.id} className="relative group border border-slate-200 rounded-xl p-4 hover:border-slate-300 transition cursor-pointer" onClick={() => onOpen(p.id)}>
                <div className={`w-11 h-11 rounded-full ${c.bg} ${c.text} flex items-center justify-center font-medium text-sm mb-3`}>{initials(p.name)}</div>
                <p className="text-sm font-medium text-slate-900 truncate">{p.name}</p>
                <p className="text-xs text-slate-400 mt-0.5">Ver histórico</p>
                <button onClick={(e) => { e.stopPropagation(); setConfirmDelete(p); }} className="absolute top-2 right-2 opacity-0 group-hover:opacity-100 text-slate-300 hover:text-red-500 transition" aria-label={`Remover ${p.name}`}>
                  <Trash2 size={14} />
                </button>
              </div>
            );
          })}
        </div>
      )}

      {confirmDelete && (
        <ConfirmModal
          title={`Remover ${confirmDelete.name}?`}
          message="Isso apaga o perfil e todo o histórico de exames e PDFs guardados dessa pessoa. Essa ação não pode ser desfeita."
          confirmLabel="Remover"
          onCancel={() => setConfirmDelete(null)}
          onConfirm={() => { onRemove(confirmDelete.id); setConfirmDelete(null); }}
        />
      )}
    </div>
  );
}

function AddProfileModal({ onClose, onConfirm }) {
  const [name, setName] = useState("");
  return (
    <ModalShell onClose={onClose} title="Novo perfil">
      <label className="text-xs text-slate-500 mb-1 block">Nome da pessoa</label>
      <input
        autoFocus
        value={name}
        onChange={(e) => setName(e.target.value)}
        placeholder="Ex: Ana, Pedro, Mãe..."
        className="w-full border border-slate-300 rounded-lg px-3 py-2 text-sm mb-4 focus:outline-none focus:ring-2 focus:ring-slate-300"
        onKeyDown={(e) => { if (e.key === "Enter" && name.trim()) onConfirm(name.trim()); }}
      />
      <div className="flex justify-end gap-2">
        <button onClick={onClose} className="text-sm px-3 py-2 rounded-lg text-slate-500 hover:bg-slate-100">Cancelar</button>
        <button disabled={!name.trim()} onClick={() => onConfirm(name.trim())} className="text-sm px-3.5 py-2 rounded-lg bg-slate-900 text-white disabled:opacity-40 hover:bg-slate-800">
          Criar perfil
        </button>
      </div>
    </ModalShell>
  );
}

function ModalShell({ onClose, title, children, wide }) {
  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center p-4" style={{ background: "rgba(15,23,42,0.4)" }} onClick={onClose}>
      <div className={`bg-white rounded-2xl shadow-xl p-5 w-full ${wide ? "max-w-2xl" : "max-w-sm"} max-h-[85vh] overflow-y-auto`} onClick={(e) => e.stopPropagation()}>
        <div className="flex items-center justify-between mb-4">
          <h2 className="text-base font-medium text-slate-900">{title}</h2>
          <button onClick={onClose} className="text-slate-400 hover:text-slate-600"><X size={18} /></button>
        </div>
        {children}
      </div>
    </div>
  );
}

function ConfirmModal({ title, message, confirmLabel, onCancel, onConfirm }) {
  return (
    <ModalShell onClose={onCancel} title={title}>
      <p className="text-sm text-slate-500 mb-5">{message}</p>
      <div className="flex justify-end gap-2">
        <button onClick={onCancel} className="text-sm px-3 py-2 rounded-lg text-slate-500 hover:bg-slate-100">Cancelar</button>
        <button onClick={onConfirm} className="text-sm px-3.5 py-2 rounded-lg bg-red-600 text-white hover:bg-red-700">{confirmLabel}</button>
      </div>
    </ModalShell>
  );
}

function ImportModal({ onClose, onDone }) {
  const [file, setFile] = useState(null);
  const [secret, setSecret] = useState("");
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState(null);
  const [result, setResult] = useState(null);

  const handleImport = async () => {
    setError(null);
    setLoading(true);
    try {
      if (!file) throw new Error("Escolha o arquivo de backup (.json).");
      const text = await file.text();
      let parsed;
      try {
        parsed = JSON.parse(text);
      } catch (e) {
        throw new Error("Esse arquivo não é um JSON válido de backup.");
      }
      const data = await api.importBackup(secret, parsed);
      setResult(data);
      await onDone();
    } catch (e) {
      setError(e.message || "Erro ao importar backup.");
    } finally {
      setLoading(false);
    }
  };

  return (
    <ModalShell onClose={onClose} title="Importar backup">
      {!result ? (
        <>
          <p className="text-xs text-slate-500 mb-4">
            Selecione o arquivo <code>backup-exames-....json</code> exportado do artefato do Claude, e informe a senha de importação
            (definida na variável <code>IMPORT_SECRET</code> do servidor).
          </p>
          <label className="text-xs text-slate-500 mb-1 block">Arquivo de backup</label>
          <input
            type="file"
            accept="application/json,.json"
            onChange={(e) => setFile(e.target.files?.[0] || null)}
            className="w-full text-sm mb-4 border border-slate-300 rounded-lg px-2.5 py-1.5"
          />
          <label className="text-xs text-slate-500 mb-1 block">Senha de importação</label>
          <input
            type="password"
            value={secret}
            onChange={(e) => setSecret(e.target.value)}
            placeholder="Valor de IMPORT_SECRET"
            className="w-full border border-slate-300 rounded-lg px-3 py-2 text-sm mb-4 focus:outline-none focus:ring-2 focus:ring-slate-300"
          />
          {error && (
            <div className="mb-4 flex items-start gap-2 text-sm text-red-700 bg-red-50 border border-red-200 rounded-lg px-3 py-2.5">
              <AlertTriangle size={15} className="mt-0.5 shrink-0" /> {error}
            </div>
          )}
          <div className="flex justify-end gap-2">
            <button onClick={onClose} className="text-sm px-3 py-2 rounded-lg text-slate-500 hover:bg-slate-100">Cancelar</button>
            <button
              onClick={handleImport}
              disabled={loading || !file || !secret}
              className="flex items-center gap-1.5 text-sm px-3.5 py-2 rounded-lg bg-slate-900 text-white disabled:opacity-40 hover:bg-slate-800"
            >
              {loading && <Loader2 size={14} className="animate-spin" />}
              {loading ? "Importando..." : "Importar"}
            </button>
          </div>
        </>
      ) : (
        <div>
          <div className="flex items-center gap-2 text-emerald-700 bg-emerald-50 border border-emerald-200 rounded-lg px-3 py-2.5 mb-4 text-sm">
            <CheckCircle2 size={16} className="shrink-0" />
            Importado: {result.importedProfiles} perfil(is), {result.importedBatches} laudo(s), {result.importedResults} resultado(s).
          </div>
          <div className="flex items-start gap-2 text-xs text-slate-500 bg-slate-50 rounded-lg px-3 py-2 mb-4">
            <Info size={13} className="mt-0.5 shrink-0" />
            Por segurança, remova ou troque a variável <code>IMPORT_SECRET</code> no Railway agora que já importou os dados.
          </div>
          <div className="flex justify-end">
            <button onClick={onClose} className="text-sm px-3.5 py-2 rounded-lg bg-slate-900 text-white hover:bg-slate-800">Fechar</button>
          </div>
        </div>
      )}
    </ModalShell>
  );
}

function ProfileScreen({ profile, onBack }) {
  const [index, setIndex] = useState(null);
  const [batches, setBatches] = useState({});
  const [uploading, setUploading] = useState(false);
  const [uploadError, setUploadError] = useState(null);
  const [reviewData, setReviewData] = useState(null);
  const [tipsOpen, setTipsOpen] = useState(false);
  const [selectedExam, setSelectedExam] = useState(null);
  const fileInputRef = useRef(null);

  const load = useCallback(async () => {
    const idx = await api.getBatchIndex(profile.id);
    setIndex(idx);
    const loaded = {};
    await Promise.all(idx.map(async (b) => { loaded[b.batchId] = await api.getBatch(profile.id, b.batchId); }));
    setBatches(loaded);
  }, [profile.id]);

  useEffect(() => { load(); }, [load]);

  const handleFile = async (file) => {
    setUploadError(null);
    setUploading(true);
    try {
      if (file.size > 8 * 1024 * 1024) {
        throw new Error("Esse PDF passa de 8MB — tente um arquivo menor ou exporte novamente com menos páginas.");
      }
      const parsed = await api.extractPdf(profile.id, file);
      const results = (parsed.e || []).map((r) => ({
        id: uid(), name: r.n || "", value: r.v ?? "", unit: r.u || "", ref: r.r || "",
        status: ["N", "A", "F"].includes(r.s) ? r.s : "N", category: r.c || "Outro",
      }));
      setReviewData({
        date: parsed.d || new Date().toISOString().slice(0, 10),
        lab: parsed.l || "",
        results,
        base64: parsed.base64,
        fileName: parsed.fileName,
        hash: parsed.hash,
      });
    } catch (e) {
      if (e.duplicate) {
        setUploadError(`Esse arquivo já foi importado antes (laudo de ${fmtDate(e.dupInfo.date)}, ${e.dupInfo.lab || "sem lab informado"}). Não vou importar de novo para não duplicar exames no histórico.`);
      } else {
        setUploadError(e.message || "Não consegui ler esse PDF. Tente novamente ou adicione os exames manualmente.");
      }
    } finally {
      setUploading(false);
    }
  };

  const saveBatch = async (data) => {
    const { batchId } = await api.saveBatch(profile.id, {
      date: data.date, lab: data.lab, results: data.results, base64: data.base64, fileName: data.fileName, hash: data.hash,
    });
    const newIndexEntry = { batchId, date: data.date, lab: data.lab, count: data.results.length, hash: data.hash };
    setIndex((prev) => [...(prev || []), newIndexEntry].sort((a, b) => (b.date || "").localeCompare(a.date || "")));
    setBatches((prev) => ({ ...prev, [batchId]: { date: data.date, lab: data.lab, results: data.results } }));
    setReviewData(null);
  };

  const removeBatch = async (batchId) => {
    await api.deleteBatch(profile.id, batchId);
    setIndex((prev) => (prev || []).filter((b) => b.batchId !== batchId));
    setBatches((prev) => { const n = { ...prev }; delete n[batchId]; return n; });
  };

  if (index === null) {
    return <div className="flex justify-center py-16 text-slate-400"><Loader2 className="animate-spin" size={22} /></div>;
  }

  const orderedBatchIds = index.map((b) => b.batchId);
  const latestBatch = orderedBatchIds.length ? batches[orderedBatchIds[0]] : null;
  const latestScore = latestBatch ? computeScore(latestBatch.results) : null;
  const scoreHistory = orderedBatchIds
    .map((id) => batches[id])
    .filter(Boolean)
    .map((b) => ({ date: b.date, score: computeScore(b.results) }))
    .filter((x) => x.score !== null)
    .sort((a, b) => (a.date || "").localeCompare(b.date || ""));

  let trend = null;
  if (scoreHistory.length >= 2) trend = scoreHistory[scoreHistory.length - 1].score - scoreHistory[scoreHistory.length - 2].score;

  const c = PROFILE_COLORS[profile.colorIdx % PROFILE_COLORS.length];

  return (
    <div>
      <button onClick={onBack} className="flex items-center gap-1 text-sm text-slate-500 hover:text-slate-700 mb-4">
        <ArrowLeft size={15} /> Perfis
      </button>

      <div className="flex items-start justify-between mb-6 flex-wrap gap-3">
        <div className="flex items-center gap-3">
          <div className={`w-11 h-11 rounded-full ${c.bg} ${c.text} flex items-center justify-center font-medium text-sm`}>{initials(profile.name)}</div>
          <div>
            <h1 className="text-lg font-medium text-slate-900">{profile.name}</h1>
            <p className="text-xs text-slate-400">{index.length} laudo{index.length !== 1 ? "s" : ""} no histórico</p>
          </div>
        </div>
        <div className="flex items-center gap-2">
          <input ref={fileInputRef} type="file" accept="application/pdf" className="hidden" onChange={(e) => { const f = e.target.files?.[0]; if (f) handleFile(f); e.target.value = ""; }} />
          <button onClick={() => fileInputRef.current?.click()} disabled={uploading} className="flex items-center gap-1.5 bg-slate-900 text-white text-sm font-medium px-3.5 py-2 rounded-lg hover:bg-slate-800 disabled:opacity-50">
            {uploading ? <Loader2 size={15} className="animate-spin" /> : <Upload size={15} />}
            {uploading ? "Lendo PDF..." : "Enviar PDF de exame"}
          </button>
        </div>
      </div>

      {uploadError && (
        <div className="mb-4 flex items-start gap-2 text-sm text-red-700 bg-red-50 border border-red-200 rounded-lg px-3 py-2.5">
          <AlertTriangle size={16} className="mt-0.5 shrink-0" />
          <div className="flex-1">{uploadError}</div>
          {!uploadError.startsWith("Esse arquivo já foi importado") && (
            <button onClick={() => setReviewData({ date: new Date().toISOString().slice(0, 10), lab: "", results: [], base64: null })} className="text-xs underline whitespace-nowrap">
              Adicionar manualmente
            </button>
          )}
        </div>
      )}

      {latestBatch && (
        <div className="grid grid-cols-1 sm:grid-cols-3 gap-3 mb-6">
          <ScoreCard score={latestScore} trend={trend} />
          <CountCard label="Última coleta" value={fmtDate(latestBatch.date)} sub={latestBatch.lab || "Laboratório não informado"} />
          <TipsCard onOpen={() => setTipsOpen(true)} />
        </div>
      )}

      {scoreHistory.length >= 2 && (
        <div className="border border-slate-200 rounded-xl p-4 mb-6">
          <p className="text-sm font-medium text-slate-700 mb-3">Evolução do score geral</p>
          <ResponsiveContainer width="100%" height={160}>
            <LineChart data={scoreHistory} margin={{ top: 5, right: 10, left: -20, bottom: 0 }}>
              <CartesianGrid strokeDasharray="3 3" stroke="#f1f5f9" />
              <XAxis dataKey="date" tickFormatter={fmtDate} tick={{ fontSize: 11, fill: "#94a3b8" }} />
              <YAxis domain={[0, 100]} tick={{ fontSize: 11, fill: "#94a3b8" }} />
              <Tooltip labelFormatter={fmtDate} formatter={(v) => [v, "Score"]} />
              <Line type="monotone" dataKey="score" stroke="#0f766e" strokeWidth={2} dot={{ r: 3 }} />
            </LineChart>
          </ResponsiveContainer>
        </div>
      )}

      {latestBatch ? (
        <ExamTable results={latestBatch.results} onSelectExam={(name) => setSelectedExam(name)} />
      ) : (
        <div className="border border-dashed border-slate-300 rounded-xl py-14 text-center text-slate-400">
          <FileText size={28} className="mx-auto mb-2" />
          <p className="text-sm">Nenhum exame ainda. Envie o primeiro PDF de laudo para começar.</p>
        </div>
      )}

      {index.length > 0 && <BatchHistory index={index} profileId={profile.id} onDelete={removeBatch} />}

      {selectedExam && <ExamEvolutionModal examName={selectedExam} orderedBatchIds={orderedBatchIds} batches={batches} onClose={() => setSelectedExam(null)} />}

      {reviewData && <ReviewModal data={reviewData} onCancel={() => setReviewData(null)} onConfirm={saveBatch} />}

      {tipsOpen && latestBatch && <TipsModal results={latestBatch.results} onClose={() => setTipsOpen(false)} />}
    </div>
  );
}

function ScoreCard({ score, trend }) {
  return (
    <div className="bg-slate-50 rounded-xl p-4">
      <p className="text-xs text-slate-500 mb-1">Score de saúde</p>
      <div className="flex items-end gap-2">
        <span className="text-2xl font-medium text-slate-900">{score ?? "—"}</span>
        <span className="text-xs text-slate-400 mb-1">/100</span>
        {trend !== null && trend !== undefined && (
          <span className={`flex items-center text-xs mb-1 ${trend > 0 ? "text-emerald-600" : trend < 0 ? "text-red-600" : "text-slate-400"}`}>
            {trend > 0 ? <TrendingUp size={13} /> : trend < 0 ? <TrendingDown size={13} /> : <Minus size={13} />}
            {trend !== 0 ? Math.abs(trend) : ""}
          </span>
        )}
      </div>
    </div>
  );
}
function CountCard({ label, value, sub }) {
  return (
    <div className="bg-slate-50 rounded-xl p-4">
      <p className="text-xs text-slate-500 mb-1">{label}</p>
      <p className="text-lg font-medium text-slate-900">{value}</p>
      <p className="text-xs text-slate-400 truncate mt-0.5">{sub}</p>
    </div>
  );
}
function TipsCard({ onOpen }) {
  return (
    <button onClick={onOpen} className="bg-slate-50 rounded-xl p-4 text-left hover:bg-slate-100 transition">
      <p className="text-xs text-slate-500 mb-1 flex items-center gap-1"><Sparkles size={12} /> Dicas de saúde</p>
      <p className="text-sm font-medium text-slate-900">Ver orientações</p>
      <p className="text-xs text-slate-400 mt-0.5">Baseado nos últimos exames</p>
    </button>
  );
}

function ExamTable({ results, onSelectExam }) {
  const [filter, setFilter] = useState("all");
  const grouped = {};
  for (const r of results) {
    const cat = r.category || "Outro";
    if (!grouped[cat]) grouped[cat] = [];
    grouped[cat].push(r);
  }
  const cnt = counts(results);
  const filterFn = (r) => filter === "all" || r.status === filter;

  return (
    <div className="border border-slate-200 rounded-xl overflow-hidden">
      <div className="flex items-center justify-between px-4 py-3 border-b border-slate-200 bg-slate-50">
        <p className="text-sm font-medium text-slate-700">Resultados mais recentes</p>
        <div className="flex gap-1.5">
          {["all", "F", "A", "N"].map((s) => (
            <button key={s} onClick={() => setFilter(s)} className={`text-xs px-2 py-1 rounded-full border ${filter === s ? "border-slate-400 bg-white" : "border-transparent text-slate-400"}`}>
              {s === "all" ? `Todos (${results.length})` : `${STATUS_META[s].label} (${cnt[s]})`}
            </button>
          ))}
        </div>
      </div>
      <div className="divide-y divide-slate-100">
        {Object.entries(grouped).map(([cat, items]) => {
          const visible = items.filter(filterFn);
          if (!visible.length) return null;
          return (
            <div key={cat}>
              <p className="text-xs font-medium text-slate-400 uppercase tracking-wide px-4 pt-3 pb-1">{cat}</p>
              {visible.map((r) => {
                const meta = STATUS_META[r.status] || STATUS_META.N;
                return (
                  <div key={r.id} onClick={() => onSelectExam(r.name)} className="flex items-center justify-between px-4 py-2.5 hover:bg-slate-50 cursor-pointer">
                    <div className="flex items-center gap-2.5 min-w-0">
                      <span className={`w-2 h-2 rounded-full shrink-0 ${meta.dot}`} />
                      <span className="text-sm text-slate-800 truncate">{r.name}</span>
                    </div>
                    <div className="flex items-center gap-3 shrink-0">
                      <span className="text-sm text-slate-600">{r.value} {r.unit}</span>
                      <span className="text-xs text-slate-400 hidden sm:inline">ref: {r.ref || "—"}</span>
                      <span className={`text-xs px-2 py-0.5 rounded-full ${meta.chip}`}>{meta.label}</span>
                      <ChevronRight size={14} className="text-slate-300" />
                    </div>
                  </div>
                );
              })}
            </div>
          );
        })}
      </div>
    </div>
  );
}

function BatchHistory({ index, profileId, onDelete }) {
  const [confirmDelete, setConfirmDelete] = useState(null);
  return (
    <div className="mt-6">
      <p className="text-sm font-medium text-slate-700 mb-2">Laudos guardados</p>
      <div className="border border-slate-200 rounded-xl divide-y divide-slate-100">
        {index.map((b) => (
          <div key={b.batchId} className="flex items-center justify-between px-4 py-2.5">
            <div className="flex items-center gap-2.5 min-w-0">
              <FileText size={15} className="text-slate-400 shrink-0" />
              <span className="text-sm text-slate-800">{fmtDate(b.date)}</span>
              <span className="text-xs text-slate-400 truncate">{b.lab || "Lab não informado"} · {b.count} exames</span>
            </div>
            <div className="flex items-center gap-1 shrink-0">
              <a href={api.pdfUrl(profileId, b.batchId)} target="_blank" rel="noreferrer" className="text-slate-400 hover:text-slate-700 p-1.5 inline-flex" aria-label="Abrir PDF original">
                <FileText size={15} />
              </a>
              <button onClick={() => setConfirmDelete(b)} className="text-slate-300 hover:text-red-500 p-1.5" aria-label="Excluir laudo">
                <Trash2 size={15} />
              </button>
            </div>
          </div>
        ))}
      </div>
      {confirmDelete && (
        <ConfirmModal
          title="Excluir este laudo?"
          message="O laudo e os resultados extraídos dele serão removidos do histórico."
          confirmLabel="Excluir"
          onCancel={() => setConfirmDelete(null)}
          onConfirm={() => { onDelete(confirmDelete.batchId); setConfirmDelete(null); }}
        />
      )}
    </div>
  );
}

function ExamEvolutionModal({ examName, orderedBatchIds, batches, onClose }) {
  const points = orderedBatchIds
    .map((id) => batches[id])
    .filter(Boolean)
    .map((b) => {
      const r = b.results.find((x) => x.name === examName);
      if (!r) return null;
      const num = parseFloat(String(r.value).replace(",", "."));
      return { date: b.date, value: isNaN(num) ? null : num, raw: r.value, unit: r.unit, status: r.status, ref: r.ref };
    })
    .filter(Boolean)
    .sort((a, b) => (a.date || "").localeCompare(b.date || ""));

  const numericPoints = points.filter((p) => p.value !== null);
  const colorMap = { N: "#10b981", A: "#f59e0b", F: "#ef4444" };

  return (
    <ModalShell onClose={onClose} title={examName} wide>
      {numericPoints.length >= 2 ? (
        <div className="mb-4">
          <ResponsiveContainer width="100%" height={200}>
            <LineChart data={numericPoints} margin={{ top: 5, right: 10, left: -10, bottom: 0 }}>
              <CartesianGrid strokeDasharray="3 3" stroke="#f1f5f9" />
              <XAxis dataKey="date" tickFormatter={fmtDate} tick={{ fontSize: 11, fill: "#94a3b8" }} />
              <YAxis tick={{ fontSize: 11, fill: "#94a3b8" }} />
              <Tooltip labelFormatter={fmtDate} formatter={(v, n, p) => [`${v} ${p.payload.unit || ""}`, "Valor"]} />
              <Line
                type="monotone"
                dataKey="value"
                stroke="#0f766e"
                strokeWidth={2}
                dot={(props) => <Dot key={props.payload.date} cx={props.cx} cy={props.cy} r={4} fill={colorMap[props.payload.status] || "#10b981"} />}
              />
            </LineChart>
          </ResponsiveContainer>
        </div>
      ) : (
        <p className="text-sm text-slate-400 mb-4">Ainda não há histórico numérico suficiente para um gráfico (precisa de pelo menos 2 medições).</p>
      )}
      <div className="divide-y divide-slate-100 border border-slate-200 rounded-lg">
        {points.slice().reverse().map((p, i) => {
          const meta = STATUS_META[p.status] || STATUS_META.N;
          return (
            <div key={i} className="flex items-center justify-between px-3 py-2 text-sm">
              <span className="text-slate-500">{fmtDate(p.date)}</span>
              <span className="text-slate-800">{p.raw} {p.unit}</span>
              <span className="text-slate-400 text-xs hidden sm:inline">ref: {p.ref || "—"}</span>
              <span className={`text-xs px-2 py-0.5 rounded-full ${meta.chip}`}>{meta.label}</span>
            </div>
          );
        })}
      </div>
    </ModalShell>
  );
}

function ReviewModal({ data, onCancel, onConfirm }) {
  const [date, setDate] = useState(data.date || "");
  const [lab, setLab] = useState(data.lab || "");
  const [results, setResults] = useState(data.results || []);

  const updateRow = (id, field, value) => setResults((prev) => prev.map((r) => (r.id === id ? { ...r, [field]: value } : r)));
  const removeRow = (id) => setResults((prev) => prev.filter((r) => r.id !== id));
  const addRow = () => setResults((prev) => [...prev, { id: uid(), name: "", value: "", unit: "", ref: "", status: "N", category: "Outro" }]);

  return (
    <ModalShell onClose={onCancel} title="Confira os exames extraídos" wide>
      <p className="text-xs text-slate-500 mb-3 flex items-center gap-1.5">
        <ClipboardEdit size={13} /> Revise e corrija antes de salvar — a leitura automática pode errar.
      </p>
      <div className="grid grid-cols-2 gap-3 mb-4">
        <div>
          <label className="text-xs text-slate-500 mb-1 block">Data da coleta</label>
          <input type="date" value={date} onChange={(e) => setDate(e.target.value)} className="w-full border border-slate-300 rounded-lg px-2.5 py-1.5 text-sm" />
        </div>
        <div>
          <label className="text-xs text-slate-500 mb-1 block">Laboratório</label>
          <input value={lab} onChange={(e) => setLab(e.target.value)} placeholder="Opcional" className="w-full border border-slate-300 rounded-lg px-2.5 py-1.5 text-sm" />
        </div>
      </div>

      <div className="max-h-80 overflow-y-auto border border-slate-200 rounded-lg">
        <table className="w-full text-sm" style={{ tableLayout: "fixed" }}>
          <thead className="bg-slate-50 sticky top-0">
            <tr className="text-left text-xs text-slate-500">
              <th className="px-2 py-1.5 font-normal" style={{ width: "28%" }}>Exame</th>
              <th className="px-2 py-1.5 font-normal" style={{ width: "16%" }}>Valor</th>
              <th className="px-2 py-1.5 font-normal" style={{ width: "12%" }}>Unid.</th>
              <th className="px-2 py-1.5 font-normal" style={{ width: "20%" }}>Referência</th>
              <th className="px-2 py-1.5 font-normal" style={{ width: "18%" }}>Status</th>
              <th style={{ width: "6%" }}></th>
            </tr>
          </thead>
          <tbody className="divide-y divide-slate-100">
            {results.map((r) => (
              <tr key={r.id}>
                <td className="px-2 py-1"><input value={r.name} onChange={(e) => updateRow(r.id, "name", e.target.value)} className="w-full border border-transparent hover:border-slate-200 focus:border-slate-300 rounded px-1.5 py-1 text-sm focus:outline-none" /></td>
                <td className="px-2 py-1"><input value={r.value} onChange={(e) => updateRow(r.id, "value", e.target.value)} className="w-full border border-transparent hover:border-slate-200 focus:border-slate-300 rounded px-1.5 py-1 text-sm focus:outline-none" /></td>
                <td className="px-2 py-1"><input value={r.unit} onChange={(e) => updateRow(r.id, "unit", e.target.value)} className="w-full border border-transparent hover:border-slate-200 focus:border-slate-300 rounded px-1.5 py-1 text-sm focus:outline-none" /></td>
                <td className="px-2 py-1"><input value={r.ref} onChange={(e) => updateRow(r.id, "ref", e.target.value)} className="w-full border border-transparent hover:border-slate-200 focus:border-slate-300 rounded px-1.5 py-1 text-sm focus:outline-none" /></td>
                <td className="px-2 py-1">
                  <select value={r.status} onChange={(e) => updateRow(r.id, "status", e.target.value)} className="w-full border border-slate-200 rounded px-1 py-1 text-xs">
                    <option value="N">Ideal</option>
                    <option value="A">Atenção</option>
                    <option value="F">Fora do ideal</option>
                  </select>
                </td>
                <td className="px-1 py-1 text-center">
                  <button onClick={() => removeRow(r.id)} className="text-slate-300 hover:text-red-500"><X size={14} /></button>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <button onClick={addRow} className="text-xs text-slate-500 hover:text-slate-800 flex items-center gap-1 mt-2">
        <Plus size={13} /> Adicionar exame
      </button>

      <div className="flex justify-end gap-2 mt-5">
        <button onClick={onCancel} className="text-sm px-3 py-2 rounded-lg text-slate-500 hover:bg-slate-100">Cancelar</button>
        <button
          disabled={!date || results.length === 0}
          onClick={() => onConfirm({ date, lab, results, base64: data.base64, fileName: data.fileName, hash: data.hash })}
          className="text-sm px-3.5 py-2 rounded-lg bg-slate-900 text-white disabled:opacity-40 hover:bg-slate-800"
        >
          Salvar no histórico
        </button>
      </div>
    </ModalShell>
  );
}

const TIPS_DISCLAIMER = "Essas orientações são gerais, geradas a partir dos valores dos exames, e não substituem uma avaliação médica. Leve esses resultados a um médico para interpretação e conduta.";

function TipsModal({ results, onClose }) {
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);
  const [tips, setTips] = useState(null);

  useEffect(() => {
    (async () => {
      try {
        setTips(await api.getTips(results));
      } catch (e) {
        setError("Não consegui gerar as dicas agora. Tente novamente em instantes.");
      } finally {
        setLoading(false);
      }
    })();
  }, [results]);

  return (
    <ModalShell onClose={onClose} title="Dicas de saúde">
      {loading && (
        <div className="flex items-center gap-2 text-slate-400 text-sm py-8 justify-center">
          <Loader2 size={16} className="animate-spin" /> Analisando os exames...
        </div>
      )}
      {error && <div className="text-sm text-red-600 flex items-center gap-2"><AlertTriangle size={15} /> {error}</div>}
      {tips && (
        <div>
          <p className="text-sm text-slate-700 mb-4">{tips.resumo}</p>
          <ul className="space-y-2 mb-4">
            {(tips.dicas || []).map((d, i) => (
              <li key={i} className="flex items-start gap-2 text-sm text-slate-700">
                <CheckCircle2 size={15} className="text-emerald-500 mt-0.5 shrink-0" /> {d}
              </li>
            ))}
          </ul>
        </div>
      )}
      <div className="flex items-start gap-2 text-xs text-slate-400 bg-slate-50 rounded-lg px-3 py-2 mt-2">
        <Info size={13} className="mt-0.5 shrink-0" /> {TIPS_DISCLAIMER}
      </div>
    </ModalShell>
  );
}
