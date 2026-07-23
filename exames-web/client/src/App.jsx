import React, { useState, useEffect, useRef, useCallback, useMemo } from "react";
import { LineChart, Line, XAxis, YAxis, CartesianGrid, Tooltip, ResponsiveContainer, Dot } from "recharts";
import {
  Upload, FileText, Plus, User, TrendingUp, TrendingDown, Minus, AlertTriangle,
  CheckCircle2, X, Loader2, ChevronRight, ArrowLeft, Trash2, Sparkles, ClipboardEdit, Info,
  FileUp, Download, Weight, Pencil, Stethoscope, Dumbbell, Camera, Watch, Link, Copy, RefreshCw,
  Footprints, PersonStanding, Bike, Waves, Mountain, CircleDot, Music, Zap, Flame, Receipt, MessageCircle,
} from "lucide-react";
import * as api from "./api.js";

// Etiqueta de versão/build — atualizada a cada arquivo novo entregue na conversa, pra dar
// pra comparar rapidinho "o que está no ar" vs "o que foi gerado", sem precisar abrir o console.
// Aparece discretamente no rodapé da tela inicial.
const APP_BUILD = "2026-07-23c · Corrigido: 'Sugerir agrupamentos com IA' processava a lista inteira de exames pendentes numa só chamada e estourava o limite de tokens em casas com muitos exames — agora processa em lotes de 40";

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

const INVOICE_CATEGORIES = [
  "Consulta médica", "Exame", "Odontológico", "Hospital", "Plano de saúde",
  "Fisioterapia", "Psicólogo", "Terapia ocupacional", "Fonoaudiologia", "Medicamento", "Outro",
];

const HEREDITARY_CONDITIONS_OPTIONS = [
  "Diabetes", "Hipertensão", "Doença cardíaca", "Câncer", "Colesterol alto",
  "Obesidade", "Doença renal", "Doença da tireoide", "AVC", "Alzheimer/Demência", "Asma/Alergias",
];

function downloadJson(filename, obj) {
  try {
    const blob = new Blob([JSON.stringify(obj)], { type: "application/json" });
    const url = URL.createObjectURL(blob);
    const link = document.createElement("a");
    link.href = url;
    link.download = filename;
    document.body.appendChild(link);
    link.click();
    document.body.removeChild(link);
    setTimeout(() => URL.revokeObjectURL(url), 30000);
    return true;
  } catch (e) {
    return false;
  }
}

function fmtBRL(v) {
  return (v || 0).toLocaleString("pt-BR", { style: "currency", currency: "BRL" });
}

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
// Junta os exames de TODOS os laudos guardados, mostrando o valor mais recente de cada exame
// (por nome). orderedBatchIds já vem ordenado do mais recente para o mais antigo (por data),
// então basta manter a primeira ocorrência de cada nome de exame encontrada.
function mergeLatestExamResults(orderedBatchIds, batches) {
  const seen = new Set();
  const merged = [];
  for (const batchId of orderedBatchIds) {
    const batch = batches[batchId];
    if (!batch || !Array.isArray(batch.results)) continue;
    for (const r of batch.results) {
      const key = (r.name || "").trim().toLowerCase();
      if (!key || seen.has(key)) continue;
      seen.add(key);
      merged.push({ ...r, batchDate: batch.date });
    }
  }
  return merged;
}

const STATUS_RANK = { N: 2, A: 1, F: 0 };

// Compara, para cada exame (por nome), a medição mais recente com a medição anterior a ela.
// Conta como "melhorou"/"piorou" apenas os exames cuja medição mais recente caiu dentro da
// janela de `days` dias — ou seja, mudanças de status que aconteceram (ou foram confirmadas)
// nesse período recente, mesmo que a medição de comparação seja mais antiga que a janela.
function computeExamTrends(orderedBatchIds, batches, days = 180) {
  const cutoff = new Date();
  cutoff.setDate(cutoff.getDate() - days);
  const cutoffIso = cutoff.toISOString().slice(0, 10);

  const batchIdsAsc = orderedBatchIds.slice().reverse(); // mais antigo -> mais recente
  const byExam = {};
  for (const batchId of batchIdsAsc) {
    const batch = batches[batchId];
    if (!batch || !Array.isArray(batch.results)) continue;
    for (const r of batch.results) {
      const key = (r.name || "").trim().toLowerCase();
      if (!key || !STATUS_RANK.hasOwnProperty(r.status)) continue;
      if (!byExam[key]) byExam[key] = [];
      byExam[key].push({ date: batch.date, status: r.status, name: r.name });
    }
  }

  const improved = [];
  const worsened = [];
  for (const key of Object.keys(byExam)) {
    const list = byExam[key];
    if (list.length < 2) continue;
    const current = list[list.length - 1];
    if (!current.date || current.date < cutoffIso) continue;
    const baseline = list[list.length - 2];
    const curRank = STATUS_RANK[current.status];
    const baseRank = STATUS_RANK[baseline.status];
    if (curRank > baseRank) improved.push(current.name);
    else if (curRank < baseRank) worsened.push(current.name);
  }
  return { improved, worsened };
}
function fmtDate(d) {
  if (!d) return "";
  try {
    const [y, m, day] = d.split("-");
    if (y && m && day) return `${day}/${m}/${y}`;
  } catch (e) {}
  return d;
}

const BODY_INDICATORS = [
  { key: "weightKg", label: "Peso", unit: "kg", decimals: 1 },
  { key: "imc", label: "IMC", unit: "", decimals: 1, computed: true },
  { key: "bodyFatPct", label: "Gordura corporal", unit: "%", decimals: 1 },
  { key: "muscleMassKg", label: "Massa muscular", unit: "kg", decimals: 1 },
  { key: "proteinPct", label: "Proteína", unit: "%", decimals: 1 },
  { key: "visceralFat", label: "Gordura visceral", unit: "", decimals: 0 },
  { key: "boneMassKg", label: "Massa óssea", unit: "kg", decimals: 2 },
  { key: "bodyWaterPct", label: "Água corporal", unit: "%", decimals: 1 },
  { key: "bmrKcal", label: "Taxa metabólica basal", unit: "kcal", decimals: 0 },
  { key: "bloodPressure", label: "Pressão arterial", unit: "mmHg", decimals: 0, isBloodPressure: true },
  { key: "restingHeartRate", label: "Frequência cardíaca em repouso", unit: "bpm", decimals: 0 },
];

function withImc(entries, profileHeightCm) {
  let lastHeight = profileHeightCm || null;
  return entries.map((e) => {
    // Compat com medições antigas que ainda guardavam altura por medição (de antes da altura
    // passar a viver no perfil). Se o perfil já tem altura definida, ela sempre tem prioridade.
    if (!profileHeightCm && e.heightCm !== null && e.heightCm !== undefined) lastHeight = e.heightCm;
    const heightForCalc = profileHeightCm || lastHeight;
    const imc = e.weightKg && heightForCalc ? Math.round((e.weightKg / ((heightForCalc / 100) ** 2)) * 10) / 10 : null;
    return { ...e, imc };
  });
}

// Painel da aba Saúde física: junta TODAS as medições (foto ou manual) e, para cada item
// (peso, %gordura, proteína etc.), usa o valor da aferição mais recente
// DESSE item específico — não só os campos que vieram na última medição cadastrada.
// Ex: se peso foi medido dia 10 e % de gordura só foi medido dia 5, o painel mostra os dois,
// cada um com sua própria data mais recente, em vez de esconder a gordura por não estar no dia 10.
const BODY_MERGE_FIELDS = [
  "weightKg", "heightCm", "bodyFatPct", "muscleMassKg", "visceralFat", "boneMassKg",
  "bodyWaterPct", "proteinPct", "bmrKcal", "restingHeartRate",
];

function mergeLatestBodyFields(withImcEntries, profileHeightCm) {
  const merged = {};
  for (const f of BODY_MERGE_FIELDS) merged[f] = null;
  let bloodPressure = null;
  for (let i = withImcEntries.length - 1; i >= 0; i--) {
    const e = withImcEntries[i];
    for (const f of BODY_MERGE_FIELDS) {
      if (merged[f] === null && e[f] !== null && e[f] !== undefined) merged[f] = e[f];
    }
    if (!bloodPressure && e.systolicBp !== null && e.systolicBp !== undefined && e.diastolicBp !== null && e.diastolicBp !== undefined) {
      bloodPressure = { systolicBp: e.systolicBp, diastolicBp: e.diastolicBp };
    }
  }
  const heightForImc = profileHeightCm || merged.heightCm;
  const imc = merged.weightKg && heightForImc ? Math.round((merged.weightKg / ((heightForImc / 100) ** 2)) * 10) / 10 : null;
  return { ...merged, heightCm: heightForImc, imc, systolicBp: bloodPressure?.systolicBp ?? null, diastolicBp: bloodPressure?.diastolicBp ?? null };
}

// Para a setinha de tendência (subiu/desceu): pega os DOIS valores mais recentes desse
// campo específico, mesmo que não venham das duas medições mais recentes no geral.
function latestTwoValues(withImcEntries, key) {
  const vals = [];
  for (let i = withImcEntries.length - 1; i >= 0 && vals.length < 2; i--) {
    const v = withImcEntries[i][key];
    if (v !== null && v !== undefined) vals.push(v);
  }
  return vals;
}

function fmtNum(v, decimals = 1) {
  if (v === null || v === undefined) return "—";
  return Number(v).toLocaleString("pt-BR", { minimumFractionDigits: decimals, maximumFractionDigits: decimals });
}

function ageFromBirthDateClient(birthDate) {
  if (!birthDate) return null;
  const b = new Date(birthDate);
  if (isNaN(b.getTime())) return null;
  const now = new Date();
  let age = now.getFullYear() - b.getFullYear();
  const hadBirthday = now.getMonth() > b.getMonth() || (now.getMonth() === b.getMonth() && now.getDate() >= b.getDate());
  if (!hadBirthday) age -= 1;
  return age;
}

// Classifica cada card como "ideal" / "atencao" / "fora" (mesmas cores já usadas nos exames:
// verde/amarelo/vermelho), usando faixas de referência gerais e conhecidas publicamente
// (OMS pro IMC, American Heart Association pra pressão, faixas usuais de bioimpedância pra
// %gordura/proteína, 60-100bpm como repouso normal). NÃO é avaliação médica personalizada —
// só o mesmo tipo de referência que qualquer calculadora de IMC ou balança já mostra.
// Retorna null quando falta dado (peso/altura/sexo) pra classificar com alguma base.
function bodyMetricStatus(key, latest, profile) {
  const gender = profile?.gender || null;
  switch (key) {
    case "weightKg":
    case "imc": {
      const imc = latest?.imc;
      if (imc === null || imc === undefined) return null;
      if (imc < 18.5) return "atencao";
      if (imc < 25) return "ideal";
      if (imc < 30) return "atencao";
      return "fora";
    }
    case "bodyFatPct": {
      const v = latest?.bodyFatPct;
      if (v === null || v === undefined || !gender) return null;
      if (gender === "F") {
        if (v < 14 || v > 39) return v > 39 ? "fora" : "atencao";
        if (v <= 31) return "ideal";
        return "atencao";
      }
      if (v < 6 || v > 31) return v > 31 ? "fora" : "atencao";
      if (v <= 24) return "ideal";
      return "atencao";
    }
    case "proteinPct": {
      const v = latest?.proteinPct;
      if (v === null || v === undefined) return null;
      if (v >= 16 && v <= 20) return "ideal";
      return "atencao";
    }
    case "bloodPressure": {
      const sys = latest?.systolicBp, dia = latest?.diastolicBp;
      if (sys === null || sys === undefined || dia === null || dia === undefined) return null;
      if (sys < 120 && dia < 80) return "ideal";
      if (sys < 140 && dia < 90) return "atencao";
      return "fora";
    }
    case "restingHeartRate": {
      const v = latest?.restingHeartRate;
      if (v === null || v === undefined) return null;
      if (v >= 60 && v <= 100) return "ideal";
      if (v > 100) return "fora";
      return "atencao"; // abaixo de 60: pode ser bom condicionamento físico OU bradicardia — sinalizamos atenção pela ambiguidade
    }
    case "visceralFat": {
      // Escala de "índice de gordura visceral" usada pela maioria das balanças de bioimpedância
      // (ex: Omron, Tanita): 1-9 saudável, 10-14 alto, 15+ muito alto.
      const v = latest?.visceralFat;
      if (v === null || v === undefined) return null;
      if (v <= 9) return "ideal";
      if (v <= 14) return "atencao";
      return "fora";
    }
    case "bodyWaterPct": {
      // Faixas usuais de água corporal total por sexo (bioimpedância). Sem sexo definido,
      // não classifica.
      const v = latest?.bodyWaterPct;
      if (v === null || v === undefined || !gender) return null;
      if (gender === "F") {
        if (v >= 45 && v <= 60) return "ideal";
        return "atencao";
      }
      if (v >= 50 && v <= 65) return "ideal";
      return "atencao";
    }
    case "bmrKcal": {
      // Não existe um número "ideal" fixo de TMB (depende de peso/altura/idade/sexo — uma
      // pessoa maior naturalmente tem TMB mais alta, o que não é "melhor" nem "pior"). Em vez
      // de inventar uma faixa, comparamos o valor medido com o esperado pela fórmula de
      // Mifflin-St Jeor (uma das mais usadas clinicamente) para o peso/altura/idade/sexo da
      // pessoa — se bater perto do esperado, o valor é consistente; se destoar muito, sinaliza
      // atenção (pode ser leitura da balança, ou algo fora do padrão).
      const v = latest?.bmrKcal;
      const weight = latest?.weightKg;
      const height = profile?.heightCm;
      const age = ageFromBirthDateClient(profile?.birthDate);
      if (v === null || v === undefined || !weight || !height || age === null || !gender) return null;
      const expected = gender === "F" ? 10 * weight + 6.25 * height - 5 * age - 161 : 10 * weight + 6.25 * height - 5 * age + 5;
      if (expected <= 0) return null;
      const pctDiff = Math.abs(v - expected) / expected;
      if (pctDiff <= 0.1) return "ideal";
      if (pctDiff <= 0.2) return "atencao";
      return "fora";
    }
    // Massa muscular e massa óssea não entram aqui de propósito: não existe uma faixa "ideal"
    // amplamente aceita sem outros dados (altura, nível de atividade, estrutura óssea), então
    // classificar isso seria inventar um critério sem base — melhor deixar sem selo do que dar
    // um sinal falso.
    default:
      return null;
  }
}

function StatusChip({ status }) {
  if (!status) return null;
  const meta = STATUS_META[{ ideal: "N", atencao: "A", fora: "F" }[status]];
  if (!meta) return null;
  return <span className={`text-[10px] px-1.5 py-0.5 rounded-full whitespace-nowrap ${meta.chip}`}>{meta.label}</span>;
}

// Deixa o nome do laboratório mais enxuto pra exibição: corta o que costuma vir depois
// (cidade/UF, separada por " - ", "/" ou vírgula) e remove a palavra "exame(s)" solta.
// Marcas de laboratório conhecidas — se o nome contiver uma delas, corta logo depois
// da marca (mesmo sem separador antes da cidade, ex: "Laboratório Unimed Jaraguá do Sul").
const KNOWN_LAB_BRANDS = [
  "unimed", "fleury", "dasa", "hermes pardini", "sabin", "alvaro", "álvaro",
  "diagnósticos da américa", "diagnosticos da america", "lavoisier", "bronstein",
  "cerba", "labi", "delboni auriemo", "delboni", "salomão zoppi", "salomao zoppi",
  "richet", "cdb", "exame dna", "biocor", "weinmann", "cedic", "labs", "cientifica",
  "científica", "citogenetica", "citogenética",
];

// Deixa o nome do laboratório mais enxuto pra exibição: corta o que costuma vir depois
// (cidade/UF, separada por " - ", "/" ou vírgula, ou logo após uma marca conhecida) e
// remove a palavra "exame(s)" solta.
function compactLabName(lab) {
  if (!lab) return lab;
  let s = lab;

  const lower = s.toLowerCase();
  const brandHit = KNOWN_LAB_BRANDS
    .map((brand) => ({ brand, idx: lower.indexOf(brand) }))
    .filter((b) => b.idx !== -1)
    .sort((a, b) => (a.idx + a.brand.length) - (b.idx + b.brand.length))[0];
  if (brandHit) {
    s = s.slice(0, brandHit.idx + brandHit.brand.length);
  } else {
    s = s.split(/\s[-–—]\s|\/|,/)[0];
  }

  s = s.replace(/\bexames?\b/gi, "");
  s = s.replace(/\s{2,}/g, " ").trim();
  s = s.replace(/\s+(de|da|do|dos|das)\s*$/i, "").trim();
  s = s.replace(/[-.,\s]+$/, "").trim();
  return s || lab;
}

export default function App() {
  const [profiles, setProfiles] = useState(null);
  const [screen, setScreen] = useState({ name: "home" });
  const [showAddProfile, setShowAddProfile] = useState(false);
  const [showImport, setShowImport] = useState(false);
  const [connectedToast, setConnectedToast] = useState(null);

  const refreshProfiles = async () => setProfiles(await api.getProfiles());

  useEffect(() => {
    refreshProfiles();
  }, []);

  useEffect(() => {
    const params = new URLSearchParams(window.location.search);
    const connectedProfile = params.get("connectedProfile");
    const provider = params.get("provider");
    if (connectedProfile) {
      setScreen({ name: "profile", profileId: connectedProfile, initialTab: "atividades" });
      setConnectedToast(provider === "strava" ? "Strava conectado com sucesso!" : "Conectado com sucesso!");
      window.history.replaceState({}, "", window.location.pathname);
      setTimeout(() => setConnectedToast(null), 6000);
    } else if (params.get("strava") === "error") {
      setConnectedToast("Não consegui conectar ao Strava. Tente novamente.");
      window.history.replaceState({}, "", window.location.pathname);
      setTimeout(() => setConnectedToast(null), 6000);
    }
  }, []);

  const addProfile = async (name, extra = {}) => {
    const newProfile = await api.createProfile(name, extra);
    setProfiles((prev) => [...(prev || []), newProfile]);
    setShowAddProfile(false);
    setScreen({ name: "profile", profileId: newProfile.id });
  };

  const removeProfile = async (id) => {
    await api.deleteProfile(id);
    setProfiles((prev) => (prev || []).filter((p) => p.id !== id));
    setScreen({ name: "home" });
  };

  const updateProfileInfo = (updated) => {
    setProfiles((prev) => (prev || []).map((p) => (p.id === updated.id ? updated : p)));
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
      {connectedToast && (
        <div className="mb-4 flex items-center gap-2 text-sm text-emerald-700 bg-emerald-50 border border-emerald-200 rounded-lg px-3 py-2.5">
          <CheckCircle2 size={15} className="shrink-0" /> {connectedToast}
        </div>
      )}
      {screen.name === "home" && (
        <HomeScreen profiles={profiles} onOpen={(id) => setScreen({ name: "profile", profileId: id })} onAdd={() => setShowAddProfile(true)} onRemove={removeProfile} onImport={() => setShowImport(true)} />
      )}
      {screen.name === "profile" && (
        profiles.find((p) => p.id === screen.profileId) ? (
          <ProfileScreen
            profile={profiles.find((p) => p.id === screen.profileId)}
            initialTab={screen.initialTab}
            onBack={() => setScreen({ name: "home" })}
            onProfileUpdate={updateProfileInfo}
          />
        ) : (
          <div className="flex items-center justify-center py-20 text-slate-400">
            <Loader2 className="animate-spin" size={22} />
          </div>
        )
      )}
      {showAddProfile && <AddProfileModal onClose={() => setShowAddProfile(false)} onConfirm={addProfile} />}
      {showImport && <ImportModal onClose={() => setShowImport(false)} onDone={refreshProfiles} />}
    </div>
  );
}

function HomeScreen({ profiles, onOpen, onAdd, onRemove, onImport }) {
  const [confirmDelete, setConfirmDelete] = useState(null);
  const [exporting, setExporting] = useState(false);
  const [exportMsg, setExportMsg] = useState(null);

  const handleExport = async () => {
    setExporting(true);
    setExportMsg(null);
    try {
      const backup = await api.exportBackup();
      const ok = downloadJson(`backup-exames-${new Date().toISOString().slice(0, 10)}.json`, backup);
      setExportMsg(
        ok
          ? "Backup baixado — procure o arquivo na pasta de Downloads padrão do seu navegador (o nome começa com \"backup-exames-\")."
          : "Não consegui iniciar o download. Tente novamente ou use outro navegador."
      );
    } catch (e) {
      setExportMsg("Não consegui gerar o backup agora. Tente novamente.");
    } finally {
      setExporting(false);
    }
  };

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
          {profiles.length > 0 && (
            <button onClick={handleExport} disabled={exporting} className="flex items-center gap-1.5 border border-slate-300 text-slate-700 text-sm font-medium px-3.5 py-2 rounded-lg hover:bg-slate-50 disabled:opacity-50">
              {exporting ? <Loader2 size={15} className="animate-spin" /> : <Download size={15} />}
              {exporting ? "Gerando..." : "Exportar backup"}
            </button>
          )}
          <button onClick={onAdd} className="flex items-center gap-1.5 bg-slate-900 text-white text-sm font-medium px-3.5 py-2 rounded-lg hover:bg-slate-800 active:scale-95 transition">
            <Plus size={16} /> Novo perfil
          </button>
        </div>
      </div>

      {exportMsg && (
        <div className="mb-4 flex items-start gap-2 text-xs text-slate-600 bg-slate-50 border border-slate-200 rounded-lg px-3 py-2">
          <Info size={13} className="mt-0.5 shrink-0" /> {exportMsg}
        </div>
      )}

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

      <p className="text-center text-[10px] text-slate-300 mt-10">build: {APP_BUILD}</p>
    </div>
  );
}

function AddProfileModal({ onClose, onConfirm }) {
  const [name, setName] = useState("");
  const [birthDate, setBirthDate] = useState("");
  const [gender, setGender] = useState("");
  const [heightCm, setHeightCm] = useState("");
  const [whatsapp, setWhatsapp] = useState("");
  const [pin, setPin] = useState("");
  const [hereditaryConditions, setHereditaryConditions] = useState([]);

  const toggleCondition = (c) => {
    setHereditaryConditions((prev) => (prev.includes(c) ? prev.filter((x) => x !== c) : [...prev, c]));
  };

  const pinInvalid = pin.length > 0 && !/^\d{4}$/.test(pin);

  const confirm = () => {
    if (!name.trim() || pinInvalid) return;
    onConfirm(name.trim(), { birthDate: birthDate || null, gender: gender || null, heightCm: heightCm || null, whatsapp: whatsapp || null, pin: pin || null, hereditaryConditions });
  };

  return (
    <ModalShell onClose={onClose} title="Novo perfil">
      <label className="text-xs text-slate-500 mb-1 block">Nome da pessoa</label>
      <input
        autoFocus
        value={name}
        onChange={(e) => setName(e.target.value)}
        placeholder="Ex: Ana, Pedro, Mãe..."
        className="w-full border border-slate-300 rounded-lg px-3 py-2 text-sm mb-4 focus:outline-none focus:ring-2 focus:ring-slate-300"
        onKeyDown={(e) => { if (e.key === "Enter" && name.trim()) confirm(); }}
      />
      <div className="grid grid-cols-3 gap-3 mb-1">
        <div>
          <label className="text-xs text-slate-500 mb-1 block">Data de nascimento</label>
          <input
            type="date"
            value={birthDate}
            onChange={(e) => setBirthDate(e.target.value)}
            className="w-full border border-slate-300 rounded-lg px-2.5 py-1.5 text-sm"
          />
        </div>
        <div>
          <label className="text-xs text-slate-500 mb-1 block">Sexo</label>
          <select value={gender} onChange={(e) => setGender(e.target.value)} className="w-full border border-slate-300 rounded-lg px-2.5 py-1.5 text-sm">
            <option value="">Não informar</option>
            <option value="F">Feminino</option>
            <option value="M">Masculino</option>
          </select>
        </div>
        <div>
          <label className="text-xs text-slate-500 mb-1 block">Altura (cm)</label>
          <input
            type="number"
            step="0.1"
            value={heightCm}
            onChange={(e) => setHeightCm(e.target.value)}
            placeholder="Ex: 175"
            className="w-full border border-slate-300 rounded-lg px-2.5 py-1.5 text-sm"
          />
        </div>
      </div>
      <p className="text-xs text-slate-400 mb-4">
        Tudo opcional — altura é usada para o IMC, e sexo pra classificar a faixa ideal de gordura corporal na aba Saúde física. Pode preencher depois também.
      </p>

      <div className="grid grid-cols-2 gap-3 mb-1">
        <div>
          <label className="text-xs text-slate-500 mb-1 block">WhatsApp</label>
          <input
            type="tel"
            value={whatsapp}
            onChange={(e) => setWhatsapp(e.target.value)}
            placeholder="Ex: (11) 91234-5678"
            className="w-full border border-slate-300 rounded-lg px-2.5 py-1.5 text-sm"
          />
        </div>
        <div>
          <label className="text-xs text-slate-500 mb-1 block">Senha de 4 dígitos</label>
          <input
            type="text"
            inputMode="numeric"
            maxLength={4}
            value={pin}
            onChange={(e) => setPin(e.target.value.replace(/\D/g, "").slice(0, 4))}
            placeholder="Ex: 1234"
            className={`w-full border rounded-lg px-2.5 py-1.5 text-sm ${pinInvalid ? "border-red-400" : "border-slate-300"}`}
          />
        </div>
      </div>
      <p className="text-xs text-slate-400 mb-4">
        WhatsApp e senha são usados juntos pra enviar exames e notas fiscais pelo número único do app pelo WhatsApp — envie uma mensagem pra ele que ele confirma sua identidade com essas duas informações.
      </p>

      <label className="text-xs text-slate-500 mb-1.5 block">Problemas de saúde hereditários (histórico familiar)</label>
      <div className="flex flex-wrap gap-1.5 mb-4">
        {HEREDITARY_CONDITIONS_OPTIONS.map((c) => (
          <button
            key={c}
            type="button"
            onClick={() => toggleCondition(c)}
            className={`text-xs px-2.5 py-1.5 rounded-full border transition ${
              hereditaryConditions.includes(c)
                ? "bg-slate-900 border-slate-900 text-white"
                : "border-slate-300 text-slate-600 hover:bg-slate-50"
            }`}
          >
            {c}
          </button>
        ))}
      </div>

      <div className="flex justify-end gap-2">
        <button onClick={onClose} className="text-sm px-3 py-2 rounded-lg text-slate-500 hover:bg-slate-100">Cancelar</button>
        <button disabled={!name.trim() || pinInvalid} onClick={confirm} className="text-sm px-3.5 py-2 rounded-lg bg-slate-900 text-white disabled:opacity-40 hover:bg-slate-800">
          Criar perfil
        </button>
      </div>
    </ModalShell>
  );
}

function EditProfileModal({ profile, onClose, onSave }) {
  const [name, setName] = useState(profile.name || "");
  const [birthDate, setBirthDate] = useState(profile.birthDate || "");
  const [gender, setGender] = useState(profile.gender || "");
  const [heightCm, setHeightCm] = useState(profile.heightCm ?? "");
  const [whatsapp, setWhatsapp] = useState(profile.whatsapp || "");
  const [pin, setPin] = useState("");
  const [hereditaryConditions, setHereditaryConditions] = useState(Array.isArray(profile.hereditaryConditions) ? profile.hereditaryConditions : []);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState(null);

  const toggleCondition = (c) => {
    setHereditaryConditions((prev) => (prev.includes(c) ? prev.filter((x) => x !== c) : [...prev, c]));
  };

  const pinInvalid = pin.length > 0 && !/^\d{4}$/.test(pin);

  const handleSave = async () => {
    if (!name.trim() || pinInvalid) return;
    setSaving(true);
    setError(null);
    try {
      // Se o campo de senha ficou em branco, não manda "pin" no payload — o backend entende
      // isso como "não mexer na senha já cadastrada". Só manda se a pessoa digitou algo novo.
      const payload = { name: name.trim(), birthDate: birthDate || null, gender: gender || null, heightCm: heightCm || null, whatsapp: whatsapp || null, hereditaryConditions };
      if (pin) payload.pin = pin;
      await onSave(payload);
    } catch (e) {
      setError(e.message || "Erro ao salvar perfil.");
    } finally {
      setSaving(false);
    }
  };

  return (
    <ModalShell onClose={onClose} title="Editar perfil">
      <label className="text-xs text-slate-500 mb-1 block">Nome da pessoa</label>
      <input
        autoFocus
        value={name}
        onChange={(e) => setName(e.target.value)}
        className="w-full border border-slate-300 rounded-lg px-3 py-2 text-sm mb-4 focus:outline-none focus:ring-2 focus:ring-slate-300"
      />
      <div className="grid grid-cols-3 gap-3 mb-2">
        <div>
          <label className="text-xs text-slate-500 mb-1 block">Data de nascimento</label>
          <input
            type="date"
            value={birthDate}
            onChange={(e) => setBirthDate(e.target.value)}
            className="w-full border border-slate-300 rounded-lg px-2.5 py-1.5 text-sm"
          />
        </div>
        <div>
          <label className="text-xs text-slate-500 mb-1 block">Sexo</label>
          <select value={gender} onChange={(e) => setGender(e.target.value)} className="w-full border border-slate-300 rounded-lg px-2.5 py-1.5 text-sm">
            <option value="">Não informar</option>
            <option value="F">Feminino</option>
            <option value="M">Masculino</option>
          </select>
        </div>
        <div>
          <label className="text-xs text-slate-500 mb-1 block">Altura (cm)</label>
          <input
            type="number"
            step="0.1"
            value={heightCm}
            onChange={(e) => setHeightCm(e.target.value)}
            placeholder="Ex: 175"
            className="w-full border border-slate-300 rounded-lg px-2.5 py-1.5 text-sm"
          />
        </div>
      </div>
      <p className="text-xs text-slate-400 mb-4">
        Altura é usada para calcular o IMC. Sexo é usado para classificar a faixa ideal de gordura corporal na aba Saúde física — nada aqui é obrigatório.
      </p>

      <div className="grid grid-cols-2 gap-3 mb-1">
        <div>
          <label className="text-xs text-slate-500 mb-1 block">WhatsApp</label>
          <input
            type="tel"
            value={whatsapp}
            onChange={(e) => setWhatsapp(e.target.value)}
            placeholder="Ex: (11) 91234-5678"
            className="w-full border border-slate-300 rounded-lg px-2.5 py-1.5 text-sm"
          />
        </div>
        <div>
          <label className="text-xs text-slate-500 mb-1 block">Senha de 4 dígitos</label>
          <input
            type="text"
            inputMode="numeric"
            maxLength={4}
            value={pin}
            onChange={(e) => setPin(e.target.value.replace(/\D/g, "").slice(0, 4))}
            placeholder={profile.hasPin ? "•••• (definida)" : "Ex: 1234"}
            className={`w-full border rounded-lg px-2.5 py-1.5 text-sm ${pinInvalid ? "border-red-400" : "border-slate-300"}`}
          />
        </div>
      </div>
      <p className="text-xs text-slate-400 mb-4">
        {profile.hasPin
          ? "Já existe uma senha cadastrada — deixe em branco pra mantê-la, ou digite 4 números novos pra trocar."
          : "WhatsApp e senha são usados juntos pra enviar exames e notas fiscais pelo número único do app pelo WhatsApp."}
      </p>

      <label className="text-xs text-slate-500 mb-1.5 block">Problemas de saúde hereditários (histórico familiar)</label>
      <div className="flex flex-wrap gap-1.5 mb-4">
        {HEREDITARY_CONDITIONS_OPTIONS.map((c) => (
          <button
            key={c}
            type="button"
            onClick={() => toggleCondition(c)}
            className={`text-xs px-2.5 py-1.5 rounded-full border transition ${
              hereditaryConditions.includes(c)
                ? "bg-slate-900 border-slate-900 text-white"
                : "border-slate-300 text-slate-600 hover:bg-slate-50"
            }`}
          >
            {c}
          </button>
        ))}
      </div>

      {error && (
        <div className="mb-4 flex items-start gap-2 text-sm text-red-700 bg-red-50 border border-red-200 rounded-lg px-3 py-2.5">
          <AlertTriangle size={15} className="mt-0.5 shrink-0" /> {error}
        </div>
      )}
      <div className="flex justify-end gap-2">
        <button onClick={onClose} className="text-sm px-3 py-2 rounded-lg text-slate-500 hover:bg-slate-100">Cancelar</button>
        <button
          disabled={!name.trim() || saving || pinInvalid}
          onClick={handleSave}
          className="flex items-center gap-1.5 text-sm px-3.5 py-2 rounded-lg bg-slate-900 text-white disabled:opacity-40 hover:bg-slate-800"
        >
          {saving && <Loader2 size={14} className="animate-spin" />}
          {saving ? "Salvando..." : "Salvar"}
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
      const data = await api.importBackup(parsed);
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
            Selecione o arquivo <code>backup-exames-....json</code> exportado do artefato do Claude. Os perfis e exames dele serão adicionados aos que já existem aqui.
          </p>
          <label className="text-xs text-slate-500 mb-1 block">Arquivo de backup</label>
          <input
            type="file"
            accept="application/json,.json"
            onChange={(e) => setFile(e.target.files?.[0] || null)}
            className="w-full text-sm mb-4 border border-slate-300 rounded-lg px-2.5 py-1.5"
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
              disabled={loading || !file}
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
            Importado: {result.importedProfiles} perfil(is), {result.importedBatches} laudo(s), {result.importedResults} resultado(s){typeof result.importedInvoices === "number" ? `, ${result.importedInvoices} nota(s) fiscal(is)` : ""}.
          </div>
          <div className="flex justify-end">
            <button onClick={onClose} className="text-sm px-3.5 py-2 rounded-lg bg-slate-900 text-white hover:bg-slate-800">Fechar</button>
          </div>
        </div>
      )}
    </ModalShell>
  );
}

function ProfileScreen({ profile, onBack, initialTab, onProfileUpdate }) {
  const [index, setIndex] = useState(null);
  const [batches, setBatches] = useState({});
  const [uploading, setUploading] = useState(false);
  const [uploadError, setUploadError] = useState(null);
  const [reviewData, setReviewData] = useState(null);
  const [selectedExam, setSelectedExam] = useState(null);
  const [tab, setTab] = useState(initialTab || "painel");
  const [examNameFilter, setExamNameFilter] = useState(null); // { examNames: [...], label: "..." } | null
  const [editProfileOpen, setEditProfileOpen] = useState(false);
  const [waUploads, setWaUploads] = useState([]);
  const [waInboxOpen, setWaInboxOpen] = useState(false);
  const [reviewFromWaId, setReviewFromWaId] = useState(null); // id pendente sendo revisado (exame)
  const [pendingInvoiceReview, setPendingInvoiceReview] = useState(null); // { data, uploadId } pra Notas fiscais
  const [catalogModalOpen, setCatalogModalOpen] = useState(false);
  const fileInputRef = useRef(null);

  // Troca de aba "normal" (clique direto na aba): sempre limpa o filtro de exames
  // vindo dos cards do Painel, pra não ficar um filtro "escondido" ativo.
  const goToTab = (t) => {
    setTab(t);
    setExamNameFilter(null);
  };

  // Navegação vinda dos cards do Painel: pode trazer um filtro de exames específicos
  // (ex: "Exames que melhoraram/pioraram"), que fica ativo só até o usuário limpar ou
  // trocar de aba manualmente.
  const goToTabWithFilter = (t, opts) => {
    setTab(t);
    setExamNameFilter(opts && opts.examNames ? opts : null);
  };

  const load = useCallback(async () => {
    const idx = await api.getBatchIndex(profile.id);
    setIndex(idx);
    const loaded = {};
    await Promise.all(idx.map(async (b) => { loaded[b.batchId] = await api.getBatch(profile.id, b.batchId); }));
    setBatches(loaded);
  }, [profile.id]);

  useEffect(() => { load(); }, [load]);

  const loadWaUploads = useCallback(async () => {
    try {
      setWaUploads(await api.getWhatsappUploads(profile.id));
    } catch (e) {
      setWaUploads([]);
    }
  }, [profile.id]);

  useEffect(() => { loadWaUploads(); }, [loadWaUploads]);

  const reviewWaExam = async (uploadId) => {
    const detail = await api.getWhatsappUpload(profile.id, uploadId);
    const extracted = detail.extracted || {};
    const results = (extracted.e || []).map((r) => ({
      id: uid(), name: r.n || "", value: r.v ?? "", unit: r.u || "", ref: r.r || "",
      status: ["N", "A", "F"].includes(r.s) ? r.s : "N", category: r.c || "Outro",
    }));
    setReviewData({
      date: extracted.d || new Date().toISOString().slice(0, 10),
      lab: extracted.l || "",
      doctor: extracted.m || "",
      results,
      base64: detail.base64,
      fileName: detail.fileName,
      hash: detail.hash,
    });
    setReviewFromWaId(uploadId);
    goToTab("exames");
    setWaInboxOpen(false);
  };

  const reviewWaInvoice = async (uploadId) => {
    const detail = await api.getWhatsappUpload(profile.id, uploadId);
    const extracted = detail.extracted || {};
    setPendingInvoiceReview({
      data: {
        date: extracted.d || new Date().toISOString().slice(0, 10),
        provider: extracted.prov || "",
        doc: extracted.doc || "",
        value: extracted.v ?? "",
        description: extracted.desc || "",
        category: extracted.cat || "Outro",
        base64: detail.base64,
        fileName: detail.fileName,
        hash: detail.hash,
      },
      uploadId,
    });
    goToTab("notas");
    setWaInboxOpen(false);
  };

  const discardWaUpload = async (uploadId) => {
    await api.deleteWhatsappUpload(profile.id, uploadId);
    loadWaUploads();
  };

  const saveProfileEdit = async (payload) => {
    const updated = await api.updateProfile(profile.id, payload);
    onProfileUpdate(updated);
    setEditProfileOpen(false);
  };

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
        doctor: parsed.m || "",
        results,
        base64: parsed.base64,
        fileName: parsed.fileName,
        hash: parsed.hash,
      });
    } catch (e) {
      if (e.duplicate) {
        setUploadError(`Esse arquivo já foi importado antes (laudo de ${fmtDate(e.dupInfo.date)}, ${compactLabName(e.dupInfo.lab) || "sem lab informado"}). Não vou importar de novo para não duplicar exames no histórico.`);
      } else {
        setUploadError(e.message || "Não consegui ler esse PDF. Tente novamente ou adicione os exames manualmente.");
      }
    } finally {
      setUploading(false);
    }
  };

  const saveBatch = async (data) => {
    const { batchId } = await api.saveBatch(profile.id, {
      date: data.date, lab: data.lab, doctor: data.doctor, results: data.results, base64: data.base64, fileName: data.fileName, hash: data.hash,
    });
    const newIndexEntry = { batchId, date: data.date, lab: data.lab, doctor: data.doctor, count: data.results.length, hash: data.hash };
    setIndex((prev) => [...(prev || []), newIndexEntry].sort((a, b) => (b.date || "").localeCompare(a.date || "")));
    setBatches((prev) => ({ ...prev, [batchId]: { date: data.date, lab: data.lab, doctor: data.doctor, results: data.results } }));
    setReviewData(null);
    if (reviewFromWaId) {
      await api.deleteWhatsappUpload(profile.id, reviewFromWaId);
      setReviewFromWaId(null);
      loadWaUploads();
    }
  };

  const removeBatch = async (batchId) => {
    await api.deleteBatch(profile.id, batchId);
    setIndex((prev) => (prev || []).filter((b) => b.batchId !== batchId));
    setBatches((prev) => { const n = { ...prev }; delete n[batchId]; return n; });
  };

  const editBatch = async (batchId, payload) => {
    await api.updateBatch(profile.id, batchId, payload);
    setIndex((prev) => (prev || []).map((b) => (b.batchId === batchId ? { ...b, ...payload } : b)));
    setBatches((prev) => (prev[batchId] ? { ...prev, [batchId]: { ...prev[batchId], ...payload } } : prev));
  };

  if (index === null) {
    return <div className="flex justify-center py-16 text-slate-400"><Loader2 className="animate-spin" size={22} /></div>;
  }

  const orderedBatchIds = index.map((b) => b.batchId);
  // Lista "achatada": para cada exame (ex. Colesterol, Testosterona), o valor mais recente
  // encontrado em qualquer laudo já guardado — não só do último laudo enviado.
  // (Não usamos useMemo aqui de propósito: este trecho já vem depois de um "return" condicional
  // mais acima no componente, e chamar hooks depois de um retorno condicional quebra as Rules of Hooks.)
  const mergedResults = mergeLatestExamResults(orderedBatchIds, batches);
  const filteredExamResults = examNameFilter
    ? mergedResults.filter((r) =>
        examNameFilter.examNames.some((n) => n.trim().toLowerCase() === (r.name || "").trim().toLowerCase())
      )
    : mergedResults;

  const c = PROFILE_COLORS[profile.colorIdx % PROFILE_COLORS.length];

  return (
    <div>
      <button onClick={onBack} className="flex items-center gap-1 text-sm text-slate-500 hover:text-slate-700 mb-4">
        <ArrowLeft size={15} /> Perfis
      </button>

      <div className="flex items-start justify-between mb-4 flex-wrap gap-3">
        <div className="flex items-center gap-3">
          <div className={`w-11 h-11 rounded-full ${c.bg} ${c.text} flex items-center justify-center font-medium text-sm`}>{initials(profile.name)}</div>
          <div>
            <div className="flex items-center gap-1.5">
              <h1 className="text-lg font-medium text-slate-900">{profile.name}</h1>
              <button onClick={() => setEditProfileOpen(true)} className="text-slate-300 hover:text-slate-600" aria-label="Editar perfil">
                <Pencil size={13} />
              </button>
            </div>
            <p className="text-xs text-slate-400">{index.length} laudo{index.length !== 1 ? "s" : ""} no histórico</p>
          </div>
        </div>
        {tab === "exames" && (
          <div className="flex items-center gap-2">
            <button onClick={() => setCatalogModalOpen(true)} className="flex items-center gap-1.5 text-slate-600 text-sm font-medium px-3.5 py-2 rounded-lg border border-slate-200 hover:bg-slate-50">
              <ClipboardEdit size={15} /> Catálogo de exames
            </button>
            <input ref={fileInputRef} type="file" accept="application/pdf" className="hidden" onChange={(e) => { const f = e.target.files?.[0]; if (f) handleFile(f); e.target.value = ""; }} />
            <button onClick={() => fileInputRef.current?.click()} disabled={uploading} className="flex items-center gap-1.5 bg-slate-900 text-white text-sm font-medium px-3.5 py-2 rounded-lg hover:bg-slate-800 disabled:opacity-50">
              {uploading ? <Loader2 size={15} className="animate-spin" /> : <Upload size={15} />}
              {uploading ? "Lendo PDF..." : "Enviar PDF de exame"}
            </button>
          </div>
        )}
      </div>

      <div className="flex items-center gap-1 mb-6 border-b border-slate-200 overflow-x-auto">
        <button
          onClick={() => goToTab("painel")}
          className={`text-sm px-3 py-2 border-b-2 -mb-px whitespace-nowrap ${tab === "painel" ? "border-slate-900 text-slate-900 font-medium" : "border-transparent text-slate-400 hover:text-slate-600"}`}
        >
          Painel
        </button>
        <button
          onClick={() => goToTab("exames")}
          className={`text-sm px-3 py-2 border-b-2 -mb-px whitespace-nowrap ${tab === "exames" ? "border-slate-900 text-slate-900 font-medium" : "border-transparent text-slate-400 hover:text-slate-600"}`}
        >
          Exames
        </button>
        <button
          onClick={() => goToTab("corpo")}
          className={`text-sm px-3 py-2 border-b-2 -mb-px whitespace-nowrap ${tab === "corpo" ? "border-slate-900 text-slate-900 font-medium" : "border-transparent text-slate-400 hover:text-slate-600"}`}
        >
          Saúde física
        </button>
        <button
          onClick={() => goToTab("sintomas")}
          className={`text-sm px-3 py-2 border-b-2 -mb-px whitespace-nowrap ${tab === "sintomas" ? "border-slate-900 text-slate-900 font-medium" : "border-transparent text-slate-400 hover:text-slate-600"}`}
        >
          Sintomas
        </button>
        <button
          onClick={() => goToTab("atividades")}
          className={`text-sm px-3 py-2 border-b-2 -mb-px whitespace-nowrap ${tab === "atividades" ? "border-slate-900 text-slate-900 font-medium" : "border-transparent text-slate-400 hover:text-slate-600"}`}
        >
          Atividades
        </button>
        <button
          onClick={() => goToTab("notas")}
          className={`flex items-center gap-1.5 text-sm px-3 py-2 border-b-2 -mb-px whitespace-nowrap ${tab === "notas" ? "border-slate-900 text-slate-900 font-medium" : "border-transparent text-slate-400 hover:text-slate-600"}`}
        >
          <Receipt size={14} /> Notas fiscais (IR)
        </button>
      </div>

      {waUploads.length > 0 && (
        <button
          onClick={() => setWaInboxOpen(true)}
          className="w-full flex items-center justify-between gap-3 bg-emerald-50 hover:bg-emerald-100 transition border border-emerald-200 rounded-xl px-4 py-3 mb-5"
        >
          <span className="flex items-center gap-2 text-sm text-emerald-800">
            <MessageCircle size={15} />
            {waUploads.length} {waUploads.length === 1 ? "item recebido" : "itens recebidos"} pelo WhatsApp — aguardando revisão
          </span>
          <ChevronRight size={16} className="text-emerald-600 shrink-0" />
        </button>
      )}

      {tab === "painel" && (
        <DashboardScreen
          profileId={profile.id}
          profileName={profile.name}
          profile={profile}
          onGoTo={goToTabWithFilter}
        />
      )}

      {tab === "corpo" && <BodyCompositionScreen profileId={profile.id} profile={profile} />}

      {tab === "sintomas" && <SymptomsScreen profileId={profile.id} />}

      {tab === "atividades" && <ActivitiesScreen profileId={profile.id} />}

      {tab === "notas" && (
        <InvoicesPanel
          profileId={profile.id}
          pendingReview={pendingInvoiceReview}
          onConsumePendingReview={() => setPendingInvoiceReview(null)}
          onWaUploadResolved={loadWaUploads}
        />
      )}

      {tab === "exames" && (
      <>
      {uploadError && (
        <div className="mb-4 flex items-start gap-2 text-sm text-red-700 bg-red-50 border border-red-200 rounded-lg px-3 py-2.5">
          <AlertTriangle size={16} className="mt-0.5 shrink-0" />
          <div className="flex-1">{uploadError}</div>
          {!uploadError.startsWith("Esse arquivo já foi importado") && (
            <button onClick={() => setReviewData({ date: new Date().toISOString().slice(0, 10), lab: "", doctor: "", results: [], base64: null })} className="text-xs underline whitespace-nowrap">
              Adicionar manualmente
            </button>
          )}
        </div>
      )}

      {examNameFilter && (
        <div className="mb-4 flex items-center justify-between gap-2 bg-slate-50 border border-slate-200 rounded-lg px-3 py-2.5">
          <span className="text-sm text-slate-600">
            Filtro: <span className="font-medium text-slate-800">{examNameFilter.label}</span> · {filteredExamResults.length} exame{filteredExamResults.length !== 1 ? "s" : ""}
          </span>
          <button onClick={() => setExamNameFilter(null)} className="text-xs text-slate-500 hover:text-slate-800 underline whitespace-nowrap">
            Limpar filtro
          </button>
        </div>
      )}

      {mergedResults.length === 0 ? (
        <div className="border border-dashed border-slate-300 rounded-xl py-14 text-center text-slate-400">
          <FileText size={28} className="mx-auto mb-2" />
          <p className="text-sm">Nenhum exame ainda. Envie o primeiro PDF de laudo para começar.</p>
        </div>
      ) : filteredExamResults.length === 0 ? (
        <div className="border border-dashed border-slate-300 rounded-xl py-14 text-center text-slate-400">
          <FileText size={28} className="mx-auto mb-2" />
          <p className="text-sm">Nenhum exame corresponde a esse filtro.</p>
        </div>
      ) : (
        <ExamTable results={filteredExamResults} onSelectExam={(name) => setSelectedExam(name)} />
      )}

      {index.length > 0 && <BatchHistory index={index} profileId={profile.id} onDelete={removeBatch} onEdit={editBatch} />}

      {selectedExam && <ExamEvolutionModal examName={selectedExam} orderedBatchIds={orderedBatchIds} batches={batches} profileId={profile.id} onClose={() => setSelectedExam(null)} />}

      {reviewData && <ReviewModal data={reviewData} onCancel={() => { setReviewData(null); setReviewFromWaId(null); }} onConfirm={saveBatch} />}
      {catalogModalOpen && <ExamCatalogModal onClose={() => setCatalogModalOpen(false)} onChanged={load} />}
      </>
      )}

      {editProfileOpen && <EditProfileModal profile={profile} onClose={() => setEditProfileOpen(false)} onSave={saveProfileEdit} />}

      {waInboxOpen && (
        <WhatsAppInboxModal
          uploads={waUploads}
          onClose={() => setWaInboxOpen(false)}
          onReviewExam={reviewWaExam}
          onReviewInvoice={reviewWaInvoice}
          onDiscard={discardWaUpload}
        />
      )}
    </div>
  );
}

function WhatsAppInboxModal({ uploads, onClose, onReviewExam, onReviewInvoice, onDiscard }) {
  const [confirmDiscard, setConfirmDiscard] = useState(null);

  return (
    <ModalShell onClose={onClose} title="Recebidos pelo WhatsApp" wide>
      {uploads.length === 0 ? (
        <p className="text-sm text-slate-400 py-8 text-center">Nenhum item pendente.</p>
      ) : (
        <div className="border border-slate-200 rounded-lg divide-y divide-slate-100">
          {uploads.map((u) => (
            <div key={u.id} className="flex items-center justify-between px-3 py-2.5 gap-2 flex-wrap">
              <div className="flex items-center gap-2.5 min-w-0">
                {u.kind === "exame" ? <FileText size={15} className="text-slate-400 shrink-0" /> : <Receipt size={15} className="text-slate-400 shrink-0" />}
                <div className="min-w-0">
                  <p className="text-sm text-slate-800 truncate">
                    {u.kind === "exame"
                      ? `Exame · ${fmtDate(u.preview.date) || "data não identificada"} · ${u.preview.count} resultado${u.preview.count === 1 ? "" : "s"}`
                      : `Nota fiscal/recibo · ${u.preview.provider || "prestador não informado"}`}
                  </p>
                  <p className="text-xs text-slate-400">Recebido em {fmtDate(new Date(u.receivedAt).toISOString().slice(0, 10))}</p>
                </div>
              </div>
              <div className="flex items-center gap-2 shrink-0">
                <button
                  onClick={() => (u.kind === "exame" ? onReviewExam(u.id) : onReviewInvoice(u.id))}
                  className="text-xs bg-slate-900 text-white px-2.5 py-1.5 rounded-lg hover:bg-slate-800"
                >
                  Revisar
                </button>
                <button onClick={() => setConfirmDiscard(u)} className="text-slate-300 hover:text-red-500 p-1.5" aria-label="Descartar">
                  <Trash2 size={14} />
                </button>
              </div>
            </div>
          ))}
        </div>
      )}

      {confirmDiscard && (
        <ConfirmModal
          title="Descartar este item?"
          message="O arquivo recebido pelo WhatsApp será removido sem salvar no histórico."
          confirmLabel="Descartar"
          onCancel={() => setConfirmDiscard(null)}
          onConfirm={() => { onDiscard(confirmDiscard.id); setConfirmDiscard(null); }}
        />
      )}
    </ModalShell>
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
        <p className="text-sm font-medium text-slate-700">Todos os exames (valor mais recente de cada um)</p>
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

function BatchHistory({ index, profileId, onDelete, onEdit }) {
  const [confirmDelete, setConfirmDelete] = useState(null);
  const [editBatch, setEditBatch] = useState(null);
  return (
    <div className="mt-6">
      <p className="text-sm font-medium text-slate-700 mb-2">Laudos guardados</p>
      <div className="border border-slate-200 rounded-xl divide-y divide-slate-100">
        {index.map((b) => (
          <div key={b.batchId} className="flex items-center justify-between px-4 py-2.5">
            <div className="flex items-center gap-2.5 min-w-0">
              <FileText size={15} className="text-slate-400 shrink-0" />
              <span className="text-sm text-slate-800">{fmtDate(b.date)}</span>
              <span className="text-xs text-slate-400 truncate">
                {compactLabName(b.lab) || "Lab não informado"}{b.doctor ? ` · Solicitante: ${b.doctor}` : ""} · {b.count} exames
              </span>
            </div>
            <div className="flex items-center gap-1 shrink-0">
              <a href={api.pdfUrl(profileId, b.batchId)} target="_blank" rel="noreferrer" className="text-slate-400 hover:text-slate-700 p-1.5 inline-flex" aria-label="Abrir PDF original">
                <FileText size={15} />
              </a>
              <button onClick={() => setEditBatch(b)} className="text-slate-300 hover:text-slate-700 p-1.5" aria-label="Editar laudo">
                <Pencil size={15} />
              </button>
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
      {editBatch && (
        <BatchEditModal
          batch={editBatch}
          onCancel={() => setEditBatch(null)}
          onSave={async (payload) => { await onEdit(editBatch.batchId, payload); setEditBatch(null); }}
        />
      )}
    </div>
  );
}

function BatchEditModal({ batch, onCancel, onSave }) {
  const [date, setDate] = useState(batch.date || "");
  const [lab, setLab] = useState(batch.lab || "");
  const [doctor, setDoctor] = useState(batch.doctor || "");
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState(null);

  const handleSave = async () => {
    if (!date) return;
    setSaving(true);
    setError(null);
    try {
      await onSave({ date, lab, doctor });
    } catch (e) {
      setError(e.message || "Erro ao salvar.");
      setSaving(false);
    }
  };

  return (
    <ModalShell onClose={onCancel} title="Editar laudo">
      <p className="text-xs text-slate-500 mb-3">
        Edite os dados desse laudo manualmente. Isso não reprocessa o PDF nem altera os exames já salvos.
      </p>
      <div className="mb-3">
        <label className="text-xs text-slate-500 mb-1 block">Data da coleta</label>
        <input type="date" value={date} onChange={(e) => setDate(e.target.value)} className="w-full border border-slate-300 rounded-lg px-2.5 py-1.5 text-sm" />
      </div>
      <div className="mb-3">
        <label className="text-xs text-slate-500 mb-1 block">Laboratório</label>
        <input value={lab} onChange={(e) => setLab(e.target.value)} placeholder="Opcional" className="w-full border border-slate-300 rounded-lg px-2.5 py-1.5 text-sm" />
      </div>
      <div className="mb-4">
        <label className="text-xs text-slate-500 mb-1 block">Médico solicitante</label>
        <input value={doctor} onChange={(e) => setDoctor(e.target.value)} placeholder="Opcional" className="w-full border border-slate-300 rounded-lg px-2.5 py-1.5 text-sm" />
      </div>

      {error && (
        <div className="mb-4 flex items-start gap-2 text-sm text-red-700 bg-red-50 border border-red-200 rounded-lg px-3 py-2.5">
          <AlertTriangle size={15} className="mt-0.5 shrink-0" /> {error}
        </div>
      )}

      <div className="flex justify-end gap-2">
        <button onClick={onCancel} className="text-sm px-3 py-2 rounded-lg text-slate-500 hover:bg-slate-100">Cancelar</button>
        <button
          disabled={!date || saving}
          onClick={handleSave}
          className="flex items-center gap-1.5 text-sm px-3.5 py-2 rounded-lg bg-slate-900 text-white disabled:opacity-40 hover:bg-slate-800"
        >
          {saving && <Loader2 size={14} className="animate-spin" />}
          {saving ? "Salvando..." : "Salvar"}
        </button>
      </div>
    </ModalShell>
  );
}

function ExamEvolutionModal({ examName, orderedBatchIds, batches, profileId, onClose }) {
  const points = orderedBatchIds
    .map((id) => batches[id])
    .filter(Boolean)
    .map((b) => {
      const r = b.results.find((x) => x.name === examName);
      if (!r) return null;
      const num = parseFloat(String(r.value).replace(",", "."));
      return { date: b.date, value: isNaN(num) ? null : num, raw: r.value, unit: r.unit, status: r.status, ref: r.ref, category: r.category };
    })
    .filter(Boolean)
    .sort((a, b) => (a.date || "").localeCompare(b.date || ""));

  const numericPoints = points.filter((p) => p.value !== null);
  const colorMap = { N: "#10b981", A: "#f59e0b", F: "#ef4444" };

  const latestPoint = points.length ? points[points.length - 1] : null;
  const latestForApi = latestPoint
    ? { value: latestPoint.raw, unit: latestPoint.unit, ref: latestPoint.ref, status: latestPoint.status, category: latestPoint.category }
    : null;
  const latestSignature = latestForApi
    ? `${latestForApi.value}|${latestForApi.unit || ""}|${latestForApi.ref || ""}|${latestForApi.status || ""}`
    : null;
  const historyForApi = points.slice(0, -1);

  const [examInfo, setExamInfo] = useState(null);
  const [loadingExamInfo, setLoadingExamInfo] = useState(true);
  const [generatingExamInfo, setGeneratingExamInfo] = useState(false);
  const [examInfoError, setExamInfoError] = useState(null);
  const [examInfoStale, setExamInfoStale] = useState(false);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      setLoadingExamInfo(true);
      setExamInfoError(null);
      try {
        const res = await api.getExamInfo(profileId, examName, latestSignature);
        if (cancelled) return;
        setExamInfo(res.hasData ? res.data : null);
        setExamInfoStale(!!res.stale);
      } catch (e) {
        if (!cancelled) setExamInfoError(e.message || "Não consegui verificar a explicação salva.");
      } finally {
        if (!cancelled) setLoadingExamInfo(false);
      }
    })();
    return () => { cancelled = true; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [profileId, examName]);

  const runGenerateExamInfo = async () => {
    if (!latestForApi) return;
    setGeneratingExamInfo(true);
    setExamInfoError(null);
    try {
      const res = await api.generateExamInfo(profileId, { examName, latest: latestForApi, history: historyForApi });
      setExamInfo(res.data);
      setExamInfoStale(false);
    } catch (e) {
      setExamInfoError(e.message || "Não consegui gerar a explicação agora.");
    } finally {
      setGeneratingExamInfo(false);
    }
  };

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
      <div className="divide-y divide-slate-100 border border-slate-200 rounded-lg mb-4">
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

      <div className="border border-slate-200 rounded-xl p-4 bg-slate-50">
        <div className="flex items-center justify-between mb-2 gap-2">
          <p className="text-sm font-medium text-slate-700 flex items-center gap-1.5">
            <Sparkles size={14} className="text-slate-500" /> O que esse exame significa
          </p>
          {examInfo && !loadingExamInfo && (
            <button
              onClick={runGenerateExamInfo}
              disabled={generatingExamInfo}
              className="text-xs text-slate-500 hover:text-slate-800 flex items-center gap-1 disabled:opacity-50 whitespace-nowrap"
            >
              <RefreshCw size={12} className={generatingExamInfo ? "animate-spin" : ""} /> Perguntar de novo
            </button>
          )}
        </div>

        {loadingExamInfo && (
          <div className="flex items-center gap-2 text-slate-400 text-sm py-4 justify-center">
            <Loader2 size={15} className="animate-spin" /> Verificando...
          </div>
        )}

        {!loadingExamInfo && examInfoError && (
          <div className="flex items-start gap-2 text-sm text-red-700 bg-red-50 border border-red-200 rounded-lg px-3 py-2.5 mb-2">
            <AlertTriangle size={14} className="mt-0.5 shrink-0" /> {examInfoError}
          </div>
        )}

        {!loadingExamInfo && !examInfo && !generatingExamInfo && (
          <div>
            <p className="text-xs text-slate-500 mb-3">
              A IA pode explicar o que esse exame mede, o que o valor atual representa e, se estiver fora do ideal, o que fazer para melhorar.
            </p>
            <button
              onClick={runGenerateExamInfo}
              className="text-sm px-3.5 py-2 rounded-lg bg-slate-900 text-white hover:bg-slate-800 flex items-center gap-1.5"
            >
              <Sparkles size={14} /> Perguntar à IA
            </button>
          </div>
        )}

        {generatingExamInfo && (
          <div className="flex items-center gap-2 text-slate-400 text-sm py-4 justify-center">
            <Loader2 size={15} className="animate-spin" /> Analisando o exame...
          </div>
        )}

        {!generatingExamInfo && examInfo && (
          <div>
            {examInfoStale && (
              <p className="text-xs text-amber-600 mb-2">O valor desse exame mudou desde a última explicação — clique em "Perguntar de novo" para atualizar.</p>
            )}
            <p className="text-sm text-slate-700 mb-2">{examInfo.significado}</p>
            <p className="text-sm text-slate-700 mb-2">{examInfo.situacao_atual}</p>
            {Array.isArray(examInfo.acoes) && examInfo.acoes.length > 0 && (
              <div className="mt-3">
                <p className="text-xs font-medium text-slate-500 uppercase tracking-wide mb-1.5">O que fazer</p>
                <ul className="space-y-1.5">
                  {examInfo.acoes.map((a, i) => (
                    <li key={i} className="flex items-start gap-2 text-sm text-slate-700">
                      <CheckCircle2 size={14} className="text-emerald-500 mt-0.5 shrink-0" /> {a}
                    </li>
                  ))}
                </ul>
              </div>
            )}
            <div className="flex items-start gap-2 text-xs text-slate-400 bg-white rounded-lg px-3 py-2 mt-3 border border-slate-200">
              <Info size={12} className="mt-0.5 shrink-0" /> Explicação gerada por IA a partir dos seus resultados — não substitui uma avaliação médica.
            </div>
          </div>
        )}
      </div>
    </ModalShell>
  );
}

function ReviewModal({ data, onCancel, onConfirm }) {
  const [date, setDate] = useState(data.date || "");
  const [lab, setLab] = useState(data.lab || "");
  const [doctor, setDoctor] = useState(data.doctor || "");
  const [results, setResults] = useState(data.results || []);

  const updateRow = (id, field, value) => setResults((prev) => prev.map((r) => (r.id === id ? { ...r, [field]: value } : r)));
  const removeRow = (id) => setResults((prev) => prev.filter((r) => r.id !== id));
  const addRow = () => setResults((prev) => [...prev, { id: uid(), name: "", value: "", unit: "", ref: "", status: "N", category: "Outro" }]);

  return (
    <ModalShell onClose={onCancel} title="Confira os exames extraídos" wide>
      <p className="text-xs text-slate-500 mb-3 flex items-center gap-1.5">
        <ClipboardEdit size={13} /> Revise e corrija antes de salvar — a leitura automática pode errar. Para unificar nomes/referências entre laboratórios, use o "Catálogo de exames" na aba Exames depois de salvar.
      </p>
      <div className="grid grid-cols-3 gap-3 mb-4">
        <div>
          <label className="text-xs text-slate-500 mb-1 block">Data da coleta</label>
          <input type="date" value={date} onChange={(e) => setDate(e.target.value)} className="w-full border border-slate-300 rounded-lg px-2.5 py-1.5 text-sm" />
        </div>
        <div>
          <label className="text-xs text-slate-500 mb-1 block">Laboratório</label>
          <input value={lab} onChange={(e) => setLab(e.target.value)} placeholder="Opcional" className="w-full border border-slate-300 rounded-lg px-2.5 py-1.5 text-sm" />
        </div>
        <div>
          <label className="text-xs text-slate-500 mb-1 block">Médico</label>
          <input value={doctor} onChange={(e) => setDoctor(e.target.value)} placeholder="Opcional" className="w-full border border-slate-300 rounded-lg px-2.5 py-1.5 text-sm" />
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
          onClick={() => onConfirm({ date, lab, doctor, results, base64: data.base64, fileName: data.fileName, hash: data.hash })}
          className="text-sm px-3.5 py-2 rounded-lg bg-slate-900 text-white disabled:opacity-40 hover:bg-slate-800"
        >
          Salvar no histórico
        </button>
      </div>
    </ModalShell>
  );
}

function ExamCatalogModal({ onClose, onChanged }) {
  const [subTab, setSubTab] = useState("unificar"); // "unificar" | "catalogo"
  const [catalog, setCatalog] = useState(null);
  const [unmatched, setUnmatched] = useState(null);
  const [error, setError] = useState(null);

  const [selected, setSelected] = useState({}); // { [rawName]: true }
  const [groups, setGroups] = useState(null); // sugestões de agrupamento da IA
  const [suggesting, setSuggesting] = useState(false);
  const [manualMerge, setManualMerge] = useState(null); // { names, mode: "existing"|"new", catalogId, name, unit, ref }

  const [editingId, setEditingId] = useState(null);
  const [editForm, setEditForm] = useState({ name: "", unit: "", ref: "", category: "" });
  const [confirmDeleteId, setConfirmDeleteId] = useState(null);

  const loadAll = useCallback(async () => {
    try {
      const [c, u] = await Promise.all([api.getExamCatalog(), api.getUnmatchedExamNames()]);
      setCatalog(c);
      setUnmatched(u);
    } catch (e) {
      setError(e.message || "Erro ao carregar catálogo de exames");
    }
  }, []);

  useEffect(() => { loadAll(); }, [loadAll]);

  const toggleSelected = (name) => setSelected((prev) => ({ ...prev, [name]: !prev[name] }));
  const selectedNames = Object.keys(selected).filter((n) => selected[n]);

  const runSuggestGroups = async () => {
    setSuggesting(true);
    setError(null);
    try {
      const names = (unmatched || []).map((u) => u.name);
      const { groups: g } = await api.suggestExamGroups(names);
      // Só mostra grupos com 2+ nomes (grupos únicos não precisam de ação de unificação).
      setGroups(g.filter((grp) => grp.names.length > 1));
    } catch (e) {
      setError(e.message || "Não consegui gerar sugestões agora.");
    } finally {
      setSuggesting(false);
    }
  };

  const confirmGroup = async (group) => {
    setError(null);
    try {
      const firstMatch = (unmatched || []).find((u) => u.name === group.names[0]);
      await api.reconcileExamNames({
        names: group.names,
        newName: group.suggestedName,
        unit: firstMatch?.unit || "",
        ref: firstMatch?.ref || "",
      });
      setGroups((prev) => prev.filter((g) => g !== group));
      await loadAll();
      onChanged && onChanged();
    } catch (e) {
      setError(e.message || "Erro ao unificar esse grupo");
    }
  };

  const dismissGroup = (group) => setGroups((prev) => prev.filter((g) => g !== group));

  const openManualMerge = () => {
    if (selectedNames.length === 0) return;
    const first = (unmatched || []).find((u) => u.name === selectedNames[0]);
    setManualMerge({ names: selectedNames, mode: "new", catalogId: "", name: selectedNames[0], unit: first?.unit || "", ref: first?.ref || "" });
  };

  const confirmManualMerge = async () => {
    if (!manualMerge) return;
    setError(null);
    try {
      const payload = manualMerge.mode === "existing"
        ? { names: manualMerge.names, catalogId: manualMerge.catalogId }
        : { names: manualMerge.names, newName: manualMerge.name, unit: manualMerge.unit, ref: manualMerge.ref };
      await api.reconcileExamNames(payload);
      setManualMerge(null);
      setSelected({});
      await loadAll();
      onChanged && onChanged();
    } catch (e) {
      setError(e.message || "Erro ao unificar exames selecionados");
    }
  };

  const startEdit = (c) => {
    setEditingId(c.id);
    setEditForm({ name: c.name, unit: c.unit || "", ref: c.ref || "", category: c.category || "Outro" });
  };

  const saveEdit = async (id) => {
    setError(null);
    try {
      await api.updateExamCatalogEntry(id, editForm);
      setEditingId(null);
      await loadAll();
      onChanged && onChanged();
    } catch (e) {
      setError(e.message || "Erro ao salvar exame padrão");
    }
  };

  const removeEntry = async (id) => {
    await api.deleteExamCatalogEntry(id);
    setConfirmDeleteId(null);
    await loadAll();
    onChanged && onChanged();
  };

  return (
    <ModalShell onClose={onClose} title="Catálogo de exames" wide>
      <p className="text-xs text-slate-500 mb-4">
        Unifique exames com nomes diferentes entre laboratórios e mantenha uma única referência para cada um. Isso vale para todo o histórico já salvo — e para novos laudos, o app já sugere a padronização na hora de revisar.
      </p>

      <div className="flex items-center gap-1 mb-4 border-b border-slate-200">
        <button
          onClick={() => setSubTab("unificar")}
          className={`text-sm px-3 py-2 border-b-2 -mb-px ${subTab === "unificar" ? "border-slate-900 text-slate-900 font-medium" : "border-transparent text-slate-400 hover:text-slate-600"}`}
        >
          Unificar existentes {unmatched && unmatched.length > 0 ? `(${unmatched.length})` : ""}
        </button>
        <button
          onClick={() => setSubTab("catalogo")}
          className={`text-sm px-3 py-2 border-b-2 -mb-px ${subTab === "catalogo" ? "border-slate-900 text-slate-900 font-medium" : "border-transparent text-slate-400 hover:text-slate-600"}`}
        >
          Exames padrão {catalog && catalog.length > 0 ? `(${catalog.length})` : ""}
        </button>
      </div>

      {error && (
        <div className="mb-3 flex items-start gap-2 text-sm text-red-700 bg-red-50 border border-red-200 rounded-lg px-3 py-2.5">
          <AlertTriangle size={14} className="mt-0.5 shrink-0" /> {error}
        </div>
      )}

      {subTab === "unificar" && (
        <div>
          {unmatched === null ? (
            <div className="flex justify-center py-10 text-slate-400"><Loader2 className="animate-spin" size={20} /></div>
          ) : unmatched.length === 0 ? (
            <div className="border border-dashed border-slate-300 rounded-xl py-10 text-center text-slate-400 text-sm">
              Nenhum exame pendente de padronização — tudo já está unificado.
            </div>
          ) : (
            <>
              <div className="flex items-center justify-between mb-3 gap-2 flex-wrap">
                <button
                  onClick={runSuggestGroups}
                  disabled={suggesting}
                  className="text-sm px-3 py-2 rounded-lg bg-slate-900 text-white hover:bg-slate-800 disabled:opacity-50 flex items-center gap-1.5"
                >
                  {suggesting ? <Loader2 size={14} className="animate-spin" /> : <Sparkles size={14} />}
                  {suggesting ? "Analisando..." : "Sugerir agrupamentos com IA"}
                </button>
                {selectedNames.length > 0 && (
                  <button onClick={openManualMerge} className="text-sm px-3 py-2 rounded-lg border border-slate-300 hover:bg-slate-50">
                    Unificar {selectedNames.length} selecionado{selectedNames.length !== 1 ? "s" : ""} manualmente
                  </button>
                )}
              </div>

              {groups && groups.length > 0 && (
                <div className="mb-4 space-y-2">
                  <p className="text-xs font-medium text-slate-500 uppercase tracking-wide">Sugestões da IA</p>
                  {groups.map((g, i) => (
                    <div key={i} className="border border-slate-200 rounded-lg px-3 py-2.5 bg-slate-50">
                      <div className="flex items-center justify-between gap-2 mb-1.5">
                        <span className="text-sm font-medium text-slate-800">{g.suggestedName}</span>
                        <div className="flex items-center gap-2">
                          <button onClick={() => confirmGroup(g)} className="text-xs px-2.5 py-1 rounded-md bg-emerald-600 text-white hover:bg-emerald-700">Confirmar</button>
                          <button onClick={() => dismissGroup(g)} className="text-xs text-slate-400 hover:text-slate-700">Ignorar</button>
                        </div>
                      </div>
                      <p className="text-xs text-slate-500">{g.names.join(" · ")}</p>
                    </div>
                  ))}
                </div>
              )}

              <p className="text-xs text-slate-400 mb-2">Ou selecione manualmente os nomes que são o mesmo exame:</p>
              <div className="max-h-72 overflow-y-auto border border-slate-200 rounded-lg divide-y divide-slate-100">
                {unmatched.map((u) => (
                  <label key={u.name} className="flex items-center gap-3 px-3 py-2 hover:bg-slate-50 cursor-pointer text-sm">
                    <input type="checkbox" checked={!!selected[u.name]} onChange={() => toggleSelected(u.name)} />
                    <span className="flex-1 text-slate-800">{u.name}</span>
                    <span className="text-xs text-slate-400">{u.count}x</span>
                    <span className="text-xs text-slate-400 hidden sm:inline">ref: {u.ref || "—"}</span>
                  </label>
                ))}
              </div>
            </>
          )}

          {manualMerge && (
            <div className="fixed inset-0 bg-black/40 flex items-center justify-center z-50 p-4">
              <div className="bg-white rounded-xl p-5 w-full max-w-md">
                <h3 className="text-sm font-medium text-slate-800 mb-3">Unificar {manualMerge.names.length} exames</h3>
                <p className="text-xs text-slate-500 mb-3">{manualMerge.names.join(" · ")}</p>
                <div className="flex items-center gap-3 mb-3 text-sm">
                  <label className="flex items-center gap-1.5">
                    <input type="radio" checked={manualMerge.mode === "new"} onChange={() => setManualMerge((m) => ({ ...m, mode: "new" }))} /> Criar novo exame padrão
                  </label>
                  <label className="flex items-center gap-1.5">
                    <input type="radio" checked={manualMerge.mode === "existing"} onChange={() => setManualMerge((m) => ({ ...m, mode: "existing" }))} /> Usar exame já cadastrado
                  </label>
                </div>
                {manualMerge.mode === "new" ? (
                  <div className="space-y-2">
                    <input value={manualMerge.name} onChange={(e) => setManualMerge((m) => ({ ...m, name: e.target.value }))} placeholder="Nome padrão" className="w-full border border-slate-300 rounded-lg px-2.5 py-1.5 text-sm" />
                    <div className="grid grid-cols-2 gap-2">
                      <input value={manualMerge.unit} onChange={(e) => setManualMerge((m) => ({ ...m, unit: e.target.value }))} placeholder="Unidade" className="w-full border border-slate-300 rounded-lg px-2.5 py-1.5 text-sm" />
                      <input value={manualMerge.ref} onChange={(e) => setManualMerge((m) => ({ ...m, ref: e.target.value }))} placeholder="Referência única" className="w-full border border-slate-300 rounded-lg px-2.5 py-1.5 text-sm" />
                    </div>
                  </div>
                ) : (
                  <select value={manualMerge.catalogId} onChange={(e) => setManualMerge((m) => ({ ...m, catalogId: e.target.value }))} className="w-full border border-slate-300 rounded-lg px-2.5 py-1.5 text-sm">
                    <option value="">Selecione...</option>
                    {(catalog || []).map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}
                  </select>
                )}
                <div className="flex justify-end gap-2 mt-4">
                  <button onClick={() => setManualMerge(null)} className="text-sm px-3 py-2 rounded-lg text-slate-500 hover:bg-slate-100">Cancelar</button>
                  <button
                    disabled={manualMerge.mode === "new" ? !manualMerge.name.trim() : !manualMerge.catalogId}
                    onClick={confirmManualMerge}
                    className="text-sm px-3.5 py-2 rounded-lg bg-slate-900 text-white disabled:opacity-40 hover:bg-slate-800"
                  >
                    Unificar
                  </button>
                </div>
              </div>
            </div>
          )}
        </div>
      )}

      {subTab === "catalogo" && (
        <div>
          {catalog === null ? (
            <div className="flex justify-center py-10 text-slate-400"><Loader2 className="animate-spin" size={20} /></div>
          ) : catalog.length === 0 ? (
            <div className="border border-dashed border-slate-300 rounded-xl py-10 text-center text-slate-400 text-sm">
              Nenhum exame padrão cadastrado ainda.
            </div>
          ) : (
            <div className="max-h-96 overflow-y-auto border border-slate-200 rounded-lg divide-y divide-slate-100">
              {catalog.map((c) => (
                <div key={c.id} className="px-3 py-2.5">
                  {editingId === c.id ? (
                    <div className="space-y-2">
                      <input value={editForm.name} onChange={(e) => setEditForm((f) => ({ ...f, name: e.target.value }))} className="w-full border border-slate-300 rounded-lg px-2.5 py-1.5 text-sm" placeholder="Nome" />
                      <div className="grid grid-cols-2 gap-2">
                        <input value={editForm.unit} onChange={(e) => setEditForm((f) => ({ ...f, unit: e.target.value }))} className="w-full border border-slate-300 rounded-lg px-2.5 py-1.5 text-sm" placeholder="Unidade" />
                        <input value={editForm.ref} onChange={(e) => setEditForm((f) => ({ ...f, ref: e.target.value }))} className="w-full border border-slate-300 rounded-lg px-2.5 py-1.5 text-sm" placeholder="Referência" />
                      </div>
                      <div className="flex justify-end gap-2">
                        <button onClick={() => setEditingId(null)} className="text-xs px-2.5 py-1.5 rounded-md text-slate-500 hover:bg-slate-100">Cancelar</button>
                        <button onClick={() => saveEdit(c.id)} className="text-xs px-2.5 py-1.5 rounded-md bg-slate-900 text-white hover:bg-slate-800">Salvar</button>
                      </div>
                    </div>
                  ) : (
                    <div className="flex items-center justify-between gap-2">
                      <div className="min-w-0">
                        <p className="text-sm text-slate-800 truncate">{c.name}</p>
                        <p className="text-xs text-slate-400">
                          ref: {c.ref || "—"} {c.unit ? `(${c.unit})` : ""} · {c.resultCount} resultado{c.resultCount !== 1 ? "s" : ""} · {c.aliasCount} apelido{c.aliasCount !== 1 ? "s" : ""}
                        </p>
                      </div>
                      <div className="flex items-center gap-1 shrink-0">
                        <button onClick={() => startEdit(c)} className="text-slate-400 hover:text-slate-800 p-1.5"><Pencil size={14} /></button>
                        <button onClick={() => setConfirmDeleteId(c.id)} className="text-slate-400 hover:text-red-500 p-1.5"><Trash2 size={14} /></button>
                      </div>
                    </div>
                  )}
                  {confirmDeleteId === c.id && (
                    <div className="mt-2 flex items-center justify-between gap-2 bg-red-50 border border-red-200 rounded-lg px-3 py-2 text-xs text-red-700">
                      <span>Remover esse exame padrão? Os resultados ligados a ele voltam a ficar sem padronização (não são apagados).</span>
                      <div className="flex items-center gap-2 shrink-0">
                        <button onClick={() => setConfirmDeleteId(null)} className="underline">Cancelar</button>
                        <button onClick={() => removeEntry(c.id)} className="font-medium">Remover</button>
                      </div>
                    </div>
                  )}
                </div>
              ))}
            </div>
          )}
        </div>
      )}
    </ModalShell>
  );
}

function BodyCompositionScreen({ profileId, profile }) {
  const [entries, setEntries] = useState(null);
  const [formEntry, setFormEntry] = useState(null); // { ...entry } when editing, {} when adding new, null when closed
  const [confirmDelete, setConfirmDelete] = useState(null);
  const [selectedIndicator, setSelectedIndicator] = useState("weightKg");
  const [photoLoading, setPhotoLoading] = useState(false);
  const [photoError, setPhotoError] = useState(null);
  const [photoHeightNote, setPhotoHeightNote] = useState(null);
  const [metricInfoRequest, setMetricInfoRequest] = useState(null);
  const photoInputRef = useRef(null);

  const load = useCallback(async () => {
    const rows = await api.getBodyEntries(profileId);
    setEntries(rows);
  }, [profileId]);

  useEffect(() => { load(); }, [load]);

  const handlePhoto = async (file) => {
    setPhotoError(null);
    setPhotoHeightNote(null);
    setPhotoLoading(true);
    try {
      if (file.size > 8 * 1024 * 1024) {
        throw new Error("Essa imagem passa de 8MB — tente uma foto menor.");
      }
      const extracted = await api.extractBodyPhoto(profileId, file);
      const anyValue = ["weightKg", "heightCm", "bodyFatPct", "muscleMassKg", "visceralFat", "boneMassKg", "bodyWaterPct", "proteinPct", "bmrKcal", "systolicBp", "diastolicBp", "restingHeartRate"]
        .some((k) => extracted[k] !== null && extracted[k] !== undefined);
      if (!anyValue) {
        throw new Error("Não consegui ler nenhum valor legível nessa foto. Tente uma foto mais nítida ou adicione manualmente.");
      }
      if (extracted.heightCm !== null && extracted.heightCm !== undefined) {
        setPhotoHeightNote(
          profile?.heightCm
            ? `Detectei ${extracted.heightCm} cm de altura nessa foto — a altura salva no perfil (${profile.heightCm} cm) é a que vale para o IMC. Edite o perfil se precisar corrigir.`
            : `Detectei ${extracted.heightCm} cm de altura nessa foto. Como a altura agora fica no perfil (não em cada medição), defina-a no botão de editar perfil pra ela contar no IMC.`
        );
      }
      setFormEntry({
        date: extracted.date || new Date().toISOString().slice(0, 10),
        weightKg: extracted.weightKg ?? "",
        bodyFatPct: extracted.bodyFatPct ?? "",
        muscleMassKg: extracted.muscleMassKg ?? "",
        visceralFat: extracted.visceralFat ?? "",
        boneMassKg: extracted.boneMassKg ?? "",
        bodyWaterPct: extracted.bodyWaterPct ?? "",
        proteinPct: extracted.proteinPct ?? "",
        bmrKcal: extracted.bmrKcal ?? "",
        systolicBp: extracted.systolicBp ?? "",
        diastolicBp: extracted.diastolicBp ?? "",
        restingHeartRate: extracted.restingHeartRate ?? "",
        notes: "",
        fromPhoto: true,
        photoBase64: extracted.photoBase64 || null,
        photoMime: extracted.photoMime || null,
      });
    } catch (e) {
      setPhotoError(e.message || "Não consegui ler essa foto. Tente novamente ou adicione manualmente.");
    } finally {
      setPhotoLoading(false);
    }
  };

  const saveEntry = async (payload) => {
    if (payload.id) {
      await api.updateBodyEntry(profileId, payload.id, payload);
    } else {
      await api.createBodyEntry(profileId, payload);
    }
    setFormEntry(null);
    await load();
  };

  const removeEntry = async (entryId) => {
    await api.deleteBodyEntry(profileId, entryId);
    setConfirmDelete(null);
    await load();
  };

  if (entries === null) {
    return <div className="flex justify-center py-16 text-slate-400"><Loader2 className="animate-spin" size={22} /></div>;
  }

  const withImcEntries = withImc(entries, profile?.heightCm);
  const latest = withImcEntries.length ? mergeLatestBodyFields(withImcEntries, profile?.heightCm) : null;

  // Todo campo de BODY_INDICATORS vira um card — nenhum fica de fora.
  const summaryKeys = BODY_INDICATORS.map((i) => i.key);

  return (
    <div>
      <div className="flex items-center justify-between mb-4 flex-wrap gap-2">
        <p className="text-sm text-slate-500">
          {entries.length} mediç{entries.length !== 1 ? "ões" : "ão"} registrada{entries.length !== 1 ? "s" : ""}
          {profile?.heightCm ? ` · altura: ${fmtNum(profile.heightCm, 1)} cm (definida no perfil)` : " · altura não definida no perfil"}
        </p>
        <div className="flex items-center gap-2">
          <input ref={photoInputRef} type="file" accept="image/*" className="hidden" onChange={(e) => { const f = e.target.files?.[0]; if (f) handlePhoto(f); e.target.value = ""; }} />
          <button
            onClick={() => photoInputRef.current?.click()}
            disabled={photoLoading}
            className="flex items-center gap-1.5 border border-slate-300 text-slate-700 text-sm font-medium px-3.5 py-2 rounded-lg hover:bg-slate-50 disabled:opacity-50"
          >
            {photoLoading ? <Loader2 size={15} className="animate-spin" /> : <Camera size={15} />}
            {photoLoading ? "Lendo foto..." : "Enviar foto"}
          </button>
          <button
            onClick={() => setFormEntry({ date: new Date().toISOString().slice(0, 10) })}
            className="flex items-center gap-1.5 bg-slate-900 text-white text-sm font-medium px-3.5 py-2 rounded-lg hover:bg-slate-800"
          >
            <Plus size={15} /> Nova medição
          </button>
        </div>
      </div>

      {!profile?.heightCm && (
        <div className="mb-4 flex items-start gap-2 text-xs text-slate-500 bg-slate-50 border border-slate-200 rounded-lg px-3 py-2">
          <Info size={13} className="mt-0.5 shrink-0" /> Sem altura definida no perfil, o IMC não é calculado. Defina a altura no botão de editar perfil (lápis do lado do nome).
        </div>
      )}

      {photoHeightNote && (
        <div className="mb-4 flex items-start gap-2 text-xs text-slate-500 bg-slate-50 border border-slate-200 rounded-lg px-3 py-2">
          <Info size={13} className="mt-0.5 shrink-0" /> {photoHeightNote}
        </div>
      )}

      {photoError && (
        <div className="mb-4 flex items-start gap-2 text-sm text-red-700 bg-red-50 border border-red-200 rounded-lg px-3 py-2.5">
          <AlertTriangle size={16} className="mt-0.5 shrink-0" /> {photoError}
        </div>
      )}

      {entries.length === 0 ? (
        <div className="border border-dashed border-slate-300 rounded-xl py-14 text-center text-slate-400">
          <Weight size={28} className="mx-auto mb-2" />
          <p className="text-sm">Nenhuma medição ainda. Registre peso, % de gordura, massa muscular, pressão arterial, frequência cardíaca etc.</p>
        </div>
      ) : (
        <>
          <div className="grid grid-cols-2 sm:grid-cols-4 gap-3 mb-6">
            {summaryKeys.map((key) => {
              const meta = BODY_INDICATORS.find((i) => i.key === key);
              const isBP = !!meta.isBloodPressure;
              const value = !isBP && latest ? latest[key] : null;
              const [, prevValue] = !isBP ? latestTwoValues(withImcEntries, key) : [null, null];
              const diff = !isBP && value !== null && value !== undefined && prevValue !== null && prevValue !== undefined
                ? Math.round((value - prevValue) * 10) / 10
                : null;
              const status = bodyMetricStatus(key, latest, profile);
              const displayValue = isBP
                ? (latest?.systolicBp != null && latest?.diastolicBp != null ? `${fmtNum(latest.systolicBp, 0)}/${fmtNum(latest.diastolicBp, 0)}` : null)
                : value;
              const showAiButton = (status === "atencao" || status === "fora") && displayValue !== null && displayValue !== undefined;
              return (
                <div
                  key={key}
                  role="button"
                  tabIndex={0}
                  onClick={() => setSelectedIndicator(key)}
                  onKeyDown={(e) => { if (e.key === "Enter") setSelectedIndicator(key); }}
                  className={`relative text-left bg-slate-50 rounded-xl p-4 hover:bg-slate-100 transition cursor-pointer ${selectedIndicator === key ? "ring-2 ring-slate-300" : ""}`}
                >
                  {showAiButton && (
                    <button
                      onClick={(e) => {
                        e.stopPropagation();
                        setMetricInfoRequest({ key, label: meta.label, value: displayValue, unit: meta.unit, status });
                      }}
                      className="absolute top-2 right-2 text-slate-400 hover:text-slate-700 bg-white rounded-full p-1 shadow-sm border border-slate-200"
                      aria-label={`Perguntar à IA sobre ${meta.label}`}
                      title="Perguntar à IA o que seria adequado"
                    >
                      <Sparkles size={12} />
                    </button>
                  )}
                  <p className="text-xs text-slate-500 mb-1">{meta.label}</p>
                  <div className="flex items-end gap-1.5">
                    <span className="text-xl font-medium text-slate-900">{isBP ? (displayValue ?? "—") : fmtNum(value, meta.decimals)}</span>
                    <span className="text-xs text-slate-400 mb-0.5">{meta.unit}</span>
                  </div>
                  {diff !== null && diff !== 0 && (
                    <span className={`flex items-center gap-0.5 text-xs mt-0.5 ${diff > 0 ? "text-amber-600" : "text-emerald-600"}`}>
                      {diff > 0 ? <TrendingUp size={12} /> : <TrendingDown size={12} />} {fmtNum(Math.abs(diff), meta.decimals)}
                    </span>
                  )}
                  {status && <div className="mt-1.5"><StatusChip status={status} /></div>}
                </div>
              );
            })}
          </div>

          <p className="text-xs text-slate-400 mb-4">Faixas de referência são gerais, não substituem avaliação médica.</p>

          <div className="border border-slate-200 rounded-xl p-4 mb-6">
            <div className="flex items-center justify-between mb-3 flex-wrap gap-2">
              <p className="text-sm font-medium text-slate-700">Evolução</p>
              <div className="flex flex-wrap gap-1.5">
                {BODY_INDICATORS.map((ind) => (
                  <button
                    key={ind.key}
                    onClick={() => setSelectedIndicator(ind.key)}
                    className={`text-xs px-2 py-1 rounded-full border ${selectedIndicator === ind.key ? "border-slate-400 bg-white" : "border-transparent text-slate-400 hover:text-slate-600"}`}
                  >
                    {ind.label}
                  </button>
                ))}
              </div>
            </div>
            <BodyIndicatorChart indicator={BODY_INDICATORS.find((i) => i.key === selectedIndicator)} entries={withImcEntries} />
          </div>

          <div className="border border-slate-200 rounded-xl divide-y divide-slate-100">
            {withImcEntries.slice().reverse().map((e) => (
              <BodyEntryRow key={e.id} entry={e} profileId={profileId} onEdit={setFormEntry} onDelete={setConfirmDelete} />
            ))}
          </div>
        </>
      )}

      {formEntry && (
        <BodyEntryModal entry={formEntry} onCancel={() => setFormEntry(null)} onSave={saveEntry} />
      )}

      {confirmDelete && (
        <ConfirmModal
          title="Excluir esta medição?"
          message={`A medição de ${fmtDate(confirmDelete.date)} será removida do histórico de composição corporal.`}
          confirmLabel="Excluir"
          onCancel={() => setConfirmDelete(null)}
          onConfirm={() => removeEntry(confirmDelete.id)}
        />
      )}

      {metricInfoRequest && (
        <BodyMetricInfoModal
          profileId={profileId}
          metric={metricInfoRequest}
          context={{
            age: ageFromBirthDateClient(profile?.birthDate),
            gender: profile?.gender || null,
            heightCm: profile?.heightCm ?? null,
            weightKg: latest?.weightKg ?? null,
            imc: latest?.imc ?? null,
          }}
          onClose={() => setMetricInfoRequest(null)}
        />
      )}
    </div>
  );
}

function BodyEntryRow({ entry, profileId, onEdit, onDelete }) {
  return (
    <div className="px-4 py-2.5">
      <div className="flex items-center justify-between flex-wrap gap-2">
        <div className="flex items-center gap-3 flex-wrap min-w-0">
          <span className="text-sm text-slate-800 shrink-0">{fmtDate(entry.date)}</span>
          <span className="text-xs text-slate-500">{fmtNum(entry.weightKg, 1)} kg</span>
          {entry.imc !== null && <span className="text-xs text-slate-400">IMC {fmtNum(entry.imc, 1)}</span>}
          {entry.bodyFatPct !== null && <span className="text-xs text-slate-400">{fmtNum(entry.bodyFatPct, 1)}% gordura</span>}
          {entry.muscleMassKg !== null && <span className="text-xs text-slate-400">{fmtNum(entry.muscleMassKg, 1)} kg músculo</span>}
          {entry.proteinPct !== null && <span className="text-xs text-slate-400">{fmtNum(entry.proteinPct, 1)}% proteína</span>}
          {entry.systolicBp !== null && entry.diastolicBp !== null && (
            <span className="text-xs text-slate-400">{fmtNum(entry.systolicBp, 0)}/{fmtNum(entry.diastolicBp, 0)} mmHg</span>
          )}
          {entry.restingHeartRate !== null && <span className="text-xs text-slate-400">{fmtNum(entry.restingHeartRate, 0)} bpm</span>}
        </div>
        <div className="flex items-center gap-1 shrink-0">
          {entry.hasPhoto && (
            <a
              href={api.bodyPhotoUrl(profileId, entry.id)}
              target="_blank"
              rel="noreferrer"
              className="text-slate-400 hover:text-slate-700 p-1.5 inline-flex"
              aria-label="Abrir foto original"
              title="Ver foto original"
            >
              <Camera size={14} />
            </a>
          )}
          <button onClick={() => onEdit(entry)} className="text-slate-300 hover:text-slate-700 p-1.5" aria-label="Editar medição">
            <Pencil size={14} />
          </button>
          <button onClick={() => onDelete(entry)} className="text-slate-300 hover:text-red-500 p-1.5" aria-label="Excluir medição">
            <Trash2 size={15} />
          </button>
        </div>
      </div>
    </div>
  );
}

function BodyMetricInfoModal({ profileId, metric, context, onClose }) {
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);
  const [info, setInfo] = useState(null);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      setLoading(true);
      setError(null);
      try {
        const statusLabel = STATUS_META[{ ideal: "N", atencao: "A", fora: "F" }[metric.status]]?.label || "";
        const data = await api.getBodyMetricInfo(profileId, {
          metricLabel: metric.label,
          value: metric.value,
          unit: metric.unit,
          statusLabel,
          context,
        });
        if (!cancelled) setInfo(data);
      } catch (e) {
        if (!cancelled) setError(e.message || "Não consegui gerar a análise agora.");
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => { cancelled = true; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [profileId, metric.key]);

  return (
    <ModalShell onClose={onClose} title={metric.label}>
      <div className="flex items-center gap-2 mb-4">
        <span className="text-lg font-medium text-slate-900">{metric.value} {metric.unit}</span>
        <StatusChip status={metric.status} />
      </div>

      {loading && (
        <div className="flex items-center gap-2 text-slate-400 text-sm py-8 justify-center">
          <Loader2 size={16} className="animate-spin" /> Analisando...
        </div>
      )}

      {!loading && error && (
        <div className="flex items-start gap-2 text-sm text-red-700 bg-red-50 border border-red-200 rounded-lg px-3 py-2.5">
          <AlertTriangle size={15} className="mt-0.5 shrink-0" /> {error}
        </div>
      )}

      {!loading && info && (
        <div>
          <p className="text-xs font-medium text-slate-500 uppercase tracking-wide mb-1">Valor adequado</p>
          <p className="text-sm text-slate-700 mb-3">{info.valor_ideal}</p>
          <p className="text-xs font-medium text-slate-500 uppercase tracking-wide mb-1">Situação atual</p>
          <p className="text-sm text-slate-700 mb-3">{info.situacao_atual}</p>
          {Array.isArray(info.acoes) && info.acoes.length > 0 && (
            <div className="mt-2">
              <p className="text-xs font-medium text-slate-500 uppercase tracking-wide mb-1.5">O que fazer</p>
              <ul className="space-y-1.5">
                {info.acoes.map((a, i) => (
                  <li key={i} className="flex items-start gap-2 text-sm text-slate-700">
                    <CheckCircle2 size={14} className="text-emerald-500 mt-0.5 shrink-0" /> {a}
                  </li>
                ))}
              </ul>
            </div>
          )}
          <div className="flex items-start gap-2 text-xs text-slate-400 bg-slate-50 rounded-lg px-3 py-2 mt-3 border border-slate-200">
            <Info size={12} className="mt-0.5 shrink-0" /> Análise gerada por IA a partir de faixas de referência gerais — não substitui uma avaliação médica.
          </div>
        </div>
      )}
    </ModalShell>
  );
}

function BodyIndicatorChart({ indicator, entries }) {
  if (indicator.isBloodPressure) {
    const points = entries
      .filter((e) => e.systolicBp !== null && e.systolicBp !== undefined && e.diastolicBp !== null && e.diastolicBp !== undefined)
      .map((e) => ({ date: e.date, systolic: e.systolicBp, diastolic: e.diastolicBp }))
      .sort((a, b) => (a.date || "").localeCompare(b.date || ""));

    if (points.length < 2) {
      return <p className="text-sm text-slate-400 py-6 text-center">Ainda não há histórico suficiente de "Pressão arterial" para um gráfico (precisa de pelo menos 2 medições com esse dado).</p>;
    }

    return (
      <ResponsiveContainer width="100%" height={200}>
        <LineChart data={points} margin={{ top: 5, right: 10, left: -10, bottom: 0 }}>
          <CartesianGrid strokeDasharray="3 3" stroke="#f1f5f9" />
          <XAxis dataKey="date" tickFormatter={fmtDate} tick={{ fontSize: 11, fill: "#94a3b8" }} />
          <YAxis tick={{ fontSize: 11, fill: "#94a3b8" }} domain={["auto", "auto"]} />
          <Tooltip labelFormatter={fmtDate} formatter={(v, name) => [`${fmtNum(v, 0)} mmHg`, name === "systolic" ? "Sistólica" : "Diastólica"]} />
          <Line type="monotone" dataKey="systolic" stroke="#ef4444" strokeWidth={2} dot={{ r: 3 }} name="systolic" />
          <Line type="monotone" dataKey="diastolic" stroke="#f59e0b" strokeWidth={2} dot={{ r: 3 }} name="diastolic" />
        </LineChart>
      </ResponsiveContainer>
    );
  }

  const points = entries
    .map((e) => ({ date: e.date, value: e[indicator.key] }))
    .filter((p) => p.value !== null && p.value !== undefined)
    .sort((a, b) => (a.date || "").localeCompare(b.date || ""));

  if (points.length < 2) {
    return <p className="text-sm text-slate-400 py-6 text-center">Ainda não há histórico suficiente de "{indicator.label}" para um gráfico (precisa de pelo menos 2 medições com esse dado).</p>;
  }

  return (
    <ResponsiveContainer width="100%" height={200}>
      <LineChart data={points} margin={{ top: 5, right: 10, left: -10, bottom: 0 }}>
        <CartesianGrid strokeDasharray="3 3" stroke="#f1f5f9" />
        <XAxis dataKey="date" tickFormatter={fmtDate} tick={{ fontSize: 11, fill: "#94a3b8" }} />
        <YAxis tick={{ fontSize: 11, fill: "#94a3b8" }} domain={["auto", "auto"]} />
        <Tooltip labelFormatter={fmtDate} formatter={(v) => [`${fmtNum(v, indicator.decimals)} ${indicator.unit || ""}`, indicator.label]} />
        <Line type="monotone" dataKey="value" stroke="#0f766e" strokeWidth={2} dot={{ r: 3 }} />
      </LineChart>
    </ResponsiveContainer>
  );
}

const BODY_FORM_FIELDS = [
  { key: "weightKg", label: "Peso (kg)", step: "0.1" },
  { key: "bodyFatPct", label: "Gordura corporal (%)", step: "0.1" },
  { key: "muscleMassKg", label: "Massa muscular (kg)", step: "0.1" },
  { key: "proteinPct", label: "Proteína (%)", step: "0.1" },
  { key: "visceralFat", label: "Gordura visceral", step: "1" },
  { key: "boneMassKg", label: "Massa óssea (kg)", step: "0.01" },
  { key: "bodyWaterPct", label: "Água corporal (%)", step: "0.1" },
  { key: "bmrKcal", label: "Taxa metabólica basal (kcal)", step: "1" },
  { key: "restingHeartRate", label: "Frequência cardíaca (bpm)", step: "1" },
];

function BodyEntryModal({ entry, onCancel, onSave }) {
  const [form, setForm] = useState({
    date: entry.date || new Date().toISOString().slice(0, 10),
    weightKg: entry.weightKg ?? "",
    bodyFatPct: entry.bodyFatPct ?? "",
    muscleMassKg: entry.muscleMassKg ?? "",
    proteinPct: entry.proteinPct ?? "",
    visceralFat: entry.visceralFat ?? "",
    boneMassKg: entry.boneMassKg ?? "",
    bodyWaterPct: entry.bodyWaterPct ?? "",
    bmrKcal: entry.bmrKcal ?? "",
    restingHeartRate: entry.restingHeartRate ?? "",
    notes: entry.notes || "",
  });
  const [bloodPressureText, setBloodPressureText] = useState(
    entry.systolicBp != null && entry.diastolicBp != null ? `${entry.systolicBp}/${entry.diastolicBp}` : ""
  );
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState(null);

  const setField = (key, value) => setForm((prev) => ({ ...prev, [key]: value }));

  const handleSave = async () => {
    if (!form.date) return;
    let systolicBp = null;
    let diastolicBp = null;
    const trimmed = bloodPressureText.trim();
    if (trimmed) {
      const match = trimmed.match(/^(\d{2,3})\s*\/\s*(\d{2,3})$/);
      if (!match) {
        setError('Pressão arterial deve estar no formato "sistólica/diastólica", ex: 120/80.');
        return;
      }
      systolicBp = Number(match[1]);
      diastolicBp = Number(match[2]);
    }
    setSaving(true);
    setError(null);
    try {
      await onSave({ ...form, systolicBp, diastolicBp, id: entry.id, photoBase64: entry.photoBase64 || null, photoMime: entry.photoMime || null });
    } catch (e) {
      setError(e.message || "Erro ao salvar medição.");
    } finally {
      setSaving(false);
    }
  };

  return (
    <ModalShell onClose={onCancel} title={entry.id ? "Editar medição" : "Nova medição"} wide>
      {entry.fromPhoto && (
        <p className="text-xs text-slate-500 mb-3 flex items-center gap-1.5">
          <ClipboardEdit size={13} /> Revise os valores lidos da foto antes de salvar — a leitura automática pode errar.
        </p>
      )}
      <div className="mb-4">
        <label className="text-xs text-slate-500 mb-1 block">Data da medição</label>
        <input
          type="date"
          value={form.date}
          onChange={(e) => setField("date", e.target.value)}
          className="w-full sm:w-52 border border-slate-300 rounded-lg px-2.5 py-1.5 text-sm"
        />
      </div>

      <div className="grid grid-cols-2 sm:grid-cols-4 gap-3 mb-4">
        <div>
          <label className="text-xs text-slate-500 mb-1 block">Pressão arterial (mmHg)</label>
          <input
            type="text"
            inputMode="numeric"
            value={bloodPressureText}
            onChange={(e) => setBloodPressureText(e.target.value)}
            placeholder="Ex: 120/80"
            className="w-full border border-slate-300 rounded-lg px-2.5 py-1.5 text-sm"
          />
        </div>
        {BODY_FORM_FIELDS.map((f) => (
          <div key={f.key}>
            <label className="text-xs text-slate-500 mb-1 block">{f.label}</label>
            <input
              type="number"
              step={f.step}
              value={form[f.key]}
              onChange={(e) => setField(f.key, e.target.value)}
              placeholder="Opcional"
              className="w-full border border-slate-300 rounded-lg px-2.5 py-1.5 text-sm"
            />
          </div>
        ))}
      </div>

      <div className="mb-4">
        <label className="text-xs text-slate-500 mb-1 block">Notas (opcional)</label>
        <textarea
          value={form.notes}
          onChange={(e) => setField("notes", e.target.value)}
          rows={2}
          className="w-full border border-slate-300 rounded-lg px-2.5 py-1.5 text-sm resize-none"
        />
      </div>

      {error && (
        <div className="mb-4 flex items-start gap-2 text-sm text-red-700 bg-red-50 border border-red-200 rounded-lg px-3 py-2.5">
          <AlertTriangle size={15} className="mt-0.5 shrink-0" /> {error}
        </div>
      )}

      <div className="flex justify-end gap-2">
        <button onClick={onCancel} className="text-sm px-3 py-2 rounded-lg text-slate-500 hover:bg-slate-100">Cancelar</button>
        <button
          disabled={!form.date || saving}
          onClick={handleSave}
          className="flex items-center gap-1.5 text-sm px-3.5 py-2 rounded-lg bg-slate-900 text-white disabled:opacity-40 hover:bg-slate-800"
        >
          {saving && <Loader2 size={14} className="animate-spin" />}
          {saving ? "Salvando..." : "Salvar medição"}
        </button>
      </div>
    </ModalShell>
  );
}

const SEVERITY_META = {
  leve: { label: "Leve", chip: "bg-slate-100 text-slate-600" },
  moderado: { label: "Moderado", chip: "bg-amber-100 text-amber-700" },
  intenso: { label: "Intenso", chip: "bg-red-100 text-red-700" },
};

function SymptomsScreen({ profileId }) {
  const [symptoms, setSymptoms] = useState(null);
  const [formEntry, setFormEntry] = useState(null);
  const [confirmDelete, setConfirmDelete] = useState(null);

  const load = useCallback(async () => {
    setSymptoms(await api.getSymptoms(profileId));
  }, [profileId]);

  useEffect(() => { load(); }, [load]);

  const saveSymptom = async (payload) => {
    if (payload.id) {
      await api.updateSymptom(profileId, payload.id, payload);
    } else {
      await api.createSymptom(profileId, payload);
    }
    setFormEntry(null);
    await load();
  };

  const toggleStatus = async (s) => {
    await api.updateSymptom(profileId, s.id, { ...s, status: s.status === "resolvido" ? "ativo" : "resolvido" });
    await load();
  };

  const removeSymptom = async (id) => {
    await api.deleteSymptom(profileId, id);
    setConfirmDelete(null);
    await load();
  };

  if (symptoms === null) {
    return <div className="flex justify-center py-16 text-slate-400"><Loader2 className="animate-spin" size={22} /></div>;
  }

  const ordered = symptoms.slice().sort((a, b) => (b.date || "").localeCompare(a.date || ""));

  return (
    <div>
      <div className="flex items-center justify-between mb-4">
        <p className="text-sm text-slate-500">
          {symptoms.length} sintoma{symptoms.length !== 1 ? "s" : ""} registrado{symptoms.length !== 1 ? "s" : ""}
        </p>
        <button
          onClick={() => setFormEntry({ date: new Date().toISOString().slice(0, 10), description: "", severity: "", status: "ativo" })}
          className="flex items-center gap-1.5 bg-slate-900 text-white text-sm font-medium px-3.5 py-2 rounded-lg hover:bg-slate-800"
        >
          <Plus size={15} /> Novo sintoma
        </button>
      </div>

      <div className="mb-4 flex items-start gap-2 text-xs text-slate-400 bg-slate-50 rounded-lg px-3 py-2">
        <Info size={13} className="mt-0.5 shrink-0" />
        Sintomas relatados aqui entram na análise de sugestão de exames (dentro de "Dicas de saúde"), junto com os exames e a composição corporal, para deixar as sugestões mais direcionadas.
      </div>

      {symptoms.length === 0 ? (
        <div className="border border-dashed border-slate-300 rounded-xl py-14 text-center text-slate-400">
          <Stethoscope size={28} className="mx-auto mb-2" />
          <p className="text-sm">Nenhum sintoma registrado ainda.</p>
        </div>
      ) : (
        <div className="border border-slate-200 rounded-xl divide-y divide-slate-100">
          {ordered.map((s) => {
            const sevMeta = s.severity ? SEVERITY_META[s.severity] : null;
            const resolved = s.status === "resolvido";
            return (
              <div key={s.id} className="flex items-start justify-between gap-3 px-4 py-3">
                <div className="min-w-0">
                  <div className="flex items-center gap-2 flex-wrap mb-0.5">
                    <span className="text-sm text-slate-800 font-medium">{fmtDate(s.date)}</span>
                    {sevMeta && <span className={`text-xs px-2 py-0.5 rounded-full ${sevMeta.chip}`}>{sevMeta.label}</span>}
                    <span className={`text-xs px-2 py-0.5 rounded-full ${resolved ? "bg-emerald-100 text-emerald-700" : "bg-blue-100 text-blue-700"}`}>
                      {resolved ? "Resolvido" : "Ativo"}
                    </span>
                  </div>
                  <p className={`text-sm ${resolved ? "text-slate-400 line-through" : "text-slate-700"}`}>{s.description}</p>
                </div>
                <div className="flex items-center gap-1 shrink-0">
                  <button onClick={() => toggleStatus(s)} className="text-xs text-slate-400 hover:text-slate-700 underline whitespace-nowrap px-1">
                    {resolved ? "Reativar" : "Marcar resolvido"}
                  </button>
                  <button onClick={() => setFormEntry(s)} className="text-slate-300 hover:text-slate-700 p-1.5" aria-label="Editar sintoma">
                    <Pencil size={14} />
                  </button>
                  <button onClick={() => setConfirmDelete(s)} className="text-slate-300 hover:text-red-500 p-1.5" aria-label="Excluir sintoma">
                    <Trash2 size={15} />
                  </button>
                </div>
              </div>
            );
          })}
        </div>
      )}

      {formEntry && <SymptomModal entry={formEntry} onCancel={() => setFormEntry(null)} onSave={saveSymptom} />}

      {confirmDelete && (
        <ConfirmModal
          title="Excluir este sintoma?"
          message="O registro desse sintoma será removido do histórico."
          confirmLabel="Excluir"
          onCancel={() => setConfirmDelete(null)}
          onConfirm={() => removeSymptom(confirmDelete.id)}
        />
      )}
    </div>
  );
}

function SymptomModal({ entry, onCancel, onSave }) {
  const [date, setDate] = useState(entry.date || new Date().toISOString().slice(0, 10));
  const [description, setDescription] = useState(entry.description || "");
  const [severity, setSeverity] = useState(entry.severity || "");
  const [status, setStatus] = useState(entry.status || "ativo");
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState(null);

  const handleSave = async () => {
    if (!date || !description.trim()) return;
    setSaving(true);
    setError(null);
    try {
      await onSave({ id: entry.id, date, description: description.trim(), severity, status });
    } catch (e) {
      setError(e.message || "Erro ao salvar sintoma.");
    } finally {
      setSaving(false);
    }
  };

  return (
    <ModalShell onClose={onCancel} title={entry.id ? "Editar sintoma" : "Novo sintoma"}>
      <div className="mb-3">
        <label className="text-xs text-slate-500 mb-1 block">Data</label>
        <input type="date" value={date} onChange={(e) => setDate(e.target.value)} className="w-full border border-slate-300 rounded-lg px-2.5 py-1.5 text-sm" />
      </div>

      <div className="mb-3">
        <label className="text-xs text-slate-500 mb-1 block">Descrição do sintoma</label>
        <textarea
          autoFocus
          value={description}
          onChange={(e) => setDescription(e.target.value)}
          rows={3}
          placeholder="Ex: cansaço frequente à tarde, dor de cabeça, palpitação..."
          className="w-full border border-slate-300 rounded-lg px-2.5 py-1.5 text-sm resize-none"
        />
      </div>

      <div className="grid grid-cols-2 gap-3 mb-4">
        <div>
          <label className="text-xs text-slate-500 mb-1 block">Intensidade</label>
          <select value={severity} onChange={(e) => setSeverity(e.target.value)} className="w-full border border-slate-300 rounded-lg px-2.5 py-1.5 text-sm">
            <option value="">Não informar</option>
            <option value="leve">Leve</option>
            <option value="moderado">Moderado</option>
            <option value="intenso">Intenso</option>
          </select>
        </div>
        <div>
          <label className="text-xs text-slate-500 mb-1 block">Status</label>
          <select value={status} onChange={(e) => setStatus(e.target.value)} className="w-full border border-slate-300 rounded-lg px-2.5 py-1.5 text-sm">
            <option value="ativo">Ativo</option>
            <option value="resolvido">Resolvido</option>
          </select>
        </div>
      </div>

      {error && (
        <div className="mb-4 flex items-start gap-2 text-sm text-red-700 bg-red-50 border border-red-200 rounded-lg px-3 py-2.5">
          <AlertTriangle size={15} className="mt-0.5 shrink-0" /> {error}
        </div>
      )}

      <div className="flex justify-end gap-2">
        <button onClick={onCancel} className="text-sm px-3 py-2 rounded-lg text-slate-500 hover:bg-slate-100">Cancelar</button>
        <button
          disabled={!date || !description.trim() || saving}
          onClick={handleSave}
          className="flex items-center gap-1.5 text-sm px-3.5 py-2 rounded-lg bg-slate-900 text-white disabled:opacity-40 hover:bg-slate-800"
        >
          {saving && <Loader2 size={14} className="animate-spin" />}
          {saving ? "Salvando..." : "Salvar sintoma"}
        </button>
      </div>
    </ModalShell>
  );
}

const ACTIVITY_INTENSITY_META = {
  leve: { label: "Leve", chip: "bg-slate-100 text-slate-600" },
  moderada: { label: "Moderada", chip: "bg-amber-100 text-amber-700" },
  intensa: { label: "Intensa", chip: "bg-red-100 text-red-700" },
};

const ACTIVITY_TYPE_OPTIONS = [
  { value: "Corrida", Icon: Footprints },
  { value: "Caminhada", Icon: PersonStanding },
  { value: "Musculação", Icon: Dumbbell },
  { value: "Ciclismo", Icon: Bike },
  { value: "Natação", Icon: Waves },
  { value: "Yoga", Icon: Zap },
  { value: "Pilates", Icon: Zap },
  { value: "Trilha", Icon: Mountain },
  { value: "Futebol", Icon: CircleDot },
  { value: "Crossfit", Icon: Flame },
  { value: "Dança", Icon: Music },
];

function getActivityIcon(activityType) {
  if (!activityType) return Dumbbell;
  const t = activityType.toLowerCase();
  const found = ACTIVITY_TYPE_OPTIONS.find((o) => t.includes(o.value.toLowerCase()));
  return found ? found.Icon : Dumbbell;
}

function daysAgo(n) {
  const d = new Date();
  d.setDate(d.getDate() - n);
  return d.toISOString().slice(0, 10);
}

function ActivitiesScreen({ profileId }) {
  const [activities, setActivities] = useState(null);
  const [formEntry, setFormEntry] = useState(null);
  const [confirmDelete, setConfirmDelete] = useState(null);

  const load = useCallback(async () => {
    setActivities(await api.getActivities(profileId));
  }, [profileId]);

  useEffect(() => { load(); }, [load]);

  const saveActivity = async (payload) => {
    if (payload.id) {
      await api.updateActivity(profileId, payload.id, payload);
    } else {
      await api.createActivity(profileId, payload);
    }
    setFormEntry(null);
    await load();
  };

  const removeActivity = async (id) => {
    await api.deleteActivity(profileId, id);
    setConfirmDelete(null);
    await load();
  };

  if (activities === null) {
    return <div className="flex justify-center py-16 text-slate-400"><Loader2 className="animate-spin" size={22} /></div>;
  }

  const ordered = activities.slice().sort((a, b) => (b.date || "").localeCompare(a.date || ""));
  const weekStart = daysAgo(6);
  const last7 = activities.filter((a) => (a.date || "") >= weekStart);
  const weekMinutes = last7.reduce((sum, a) => sum + (a.durationMin || 0), 0);
  const weekSessions = last7.length;

  return (
    <div>
      <div className="flex items-center justify-between mb-4">
        <p className="text-sm text-slate-500">
          {activities.length} atividade{activities.length !== 1 ? "s" : ""} registrada{activities.length !== 1 ? "s" : ""}
        </p>
        <button
          onClick={() => setFormEntry({ date: new Date().toISOString().slice(0, 10), activityType: "", durationMin: "", intensity: "", distanceKm: "", caloriesKcal: "", notes: "" })}
          className="flex items-center gap-1.5 bg-slate-900 text-white text-sm font-medium px-3.5 py-2 rounded-lg hover:bg-slate-800"
        >
          <Plus size={15} /> Nova atividade
        </button>
      </div>

      <ActivityIntegrations profileId={profileId} onSynced={load} />

      {activities.length > 0 && (
        <div className="grid grid-cols-2 gap-3 mb-6">
          <div className="bg-slate-50 rounded-xl p-4">
            <p className="text-xs text-slate-500 mb-1">Sessões nos últimos 7 dias</p>
            <p className="text-xl font-medium text-slate-900">{weekSessions}</p>
          </div>
          <div className="bg-slate-50 rounded-xl p-4">
            <p className="text-xs text-slate-500 mb-1">Minutos nos últimos 7 dias</p>
            <p className="text-xl font-medium text-slate-900">{weekMinutes}</p>
          </div>
        </div>
      )}

      {activities.length === 0 ? (
        <div className="border border-dashed border-slate-300 rounded-xl py-14 text-center text-slate-400">
          <Dumbbell size={28} className="mx-auto mb-2" />
          <p className="text-sm">Nenhuma atividade registrada ainda.</p>
        </div>
      ) : (
        <div className="border border-slate-200 rounded-xl divide-y divide-slate-100">
          {ordered.map((a) => {
            const intMeta = a.intensity ? ACTIVITY_INTENSITY_META[a.intensity] : null;
            const ActivityIcon = getActivityIcon(a.activityType);
            return (
              <div key={a.id} className="flex items-start justify-between gap-3 px-4 py-3">
                <div className="min-w-0">
                  <div className="flex items-center gap-2 flex-wrap mb-0.5">
                    <span className="text-sm text-slate-800 font-medium">{fmtDate(a.date)}</span>
                    <span className="flex items-center gap-1.5 text-sm text-slate-700">
                      <ActivityIcon size={14} className="text-slate-400 shrink-0" /> {a.activityType}
                    </span>
                    {intMeta && <span className={`text-xs px-2 py-0.5 rounded-full ${intMeta.chip}`}>{intMeta.label}</span>}
                    {a.source === "strava" && <span className="text-xs px-2 py-0.5 rounded-full bg-orange-100 text-orange-700">Strava</span>}
                    {a.source === "apple_watch" && <span className="text-xs px-2 py-0.5 rounded-full bg-slate-200 text-slate-600">Apple Watch</span>}
                  </div>
                  <p className="text-xs text-slate-400">
                    {[
                      a.durationMin !== null && a.durationMin !== undefined ? `${a.durationMin} min` : null,
                      a.distanceKm !== null && a.distanceKm !== undefined ? `${a.distanceKm} km` : null,
                      a.caloriesKcal !== null && a.caloriesKcal !== undefined ? `${a.caloriesKcal} kcal` : null,
                    ].filter(Boolean).join(" · ")}
                  </p>
                </div>
                <div className="flex items-center gap-1 shrink-0">
                  <button onClick={() => setFormEntry(a)} className="text-slate-300 hover:text-slate-700 p-1.5" aria-label="Editar atividade">
                    <Pencil size={14} />
                  </button>
                  <button onClick={() => setConfirmDelete(a)} className="text-slate-300 hover:text-red-500 p-1.5" aria-label="Excluir atividade">
                    <Trash2 size={15} />
                  </button>
                </div>
              </div>
            );
          })}
        </div>
      )}

      {formEntry && <ActivityModal entry={formEntry} onCancel={() => setFormEntry(null)} onSave={saveActivity} />}

      {confirmDelete && (
        <ConfirmModal
          title="Excluir esta atividade?"
          message="O registro dessa atividade física será removido do histórico."
          confirmLabel="Excluir"
          onCancel={() => setConfirmDelete(null)}
          onConfirm={() => removeActivity(confirmDelete.id)}
        />
      )}
    </div>
  );
}

function ActivityModal({ entry, onCancel, onSave }) {
  const isPreset = ACTIVITY_TYPE_OPTIONS.some((o) => o.value === entry.activityType);
  const [form, setForm] = useState({
    date: entry.date || new Date().toISOString().slice(0, 10),
    durationMin: entry.durationMin ?? "",
    intensity: entry.intensity || "",
    distanceKm: entry.distanceKm ?? "",
    caloriesKcal: entry.caloriesKcal ?? "",
    notes: entry.notes || "",
  });
  const [typeChoice, setTypeChoice] = useState(isPreset ? entry.activityType : entry.activityType ? "Outro" : "");
  const [customType, setCustomType] = useState(isPreset ? "" : entry.activityType || "");
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState(null);

  const setField = (key, value) => setForm((prev) => ({ ...prev, [key]: value }));
  const finalType = typeChoice === "Outro" ? customType.trim() : typeChoice;

  const handleSave = async () => {
    if (!form.date || !finalType) return;
    setSaving(true);
    setError(null);
    try {
      await onSave({ ...form, activityType: finalType, id: entry.id });
    } catch (e) {
      setError(e.message || "Erro ao salvar atividade.");
    } finally {
      setSaving(false);
    }
  };

  return (
    <ModalShell onClose={onCancel} title={entry.id ? "Editar atividade" : "Nova atividade"} wide>
      <div className="grid grid-cols-2 gap-3 mb-3">
        <div>
          <label className="text-xs text-slate-500 mb-1 block">Data</label>
          <input type="date" value={form.date} onChange={(e) => setField("date", e.target.value)} className="w-full border border-slate-300 rounded-lg px-2.5 py-1.5 text-sm" />
        </div>
        <div>
          <label className="text-xs text-slate-500 mb-1 block">Tipo de atividade</label>
          <select
            autoFocus
            value={typeChoice}
            onChange={(e) => setTypeChoice(e.target.value)}
            className="w-full border border-slate-300 rounded-lg px-2.5 py-1.5 text-sm"
          >
            <option value="">Selecione...</option>
            {ACTIVITY_TYPE_OPTIONS.map((o) => (
              <option key={o.value} value={o.value}>{o.value}</option>
            ))}
            <option value="Outro">Outro...</option>
          </select>
          {typeChoice === "Outro" && (
            <input
              autoFocus
              value={customType}
              onChange={(e) => setCustomType(e.target.value)}
              placeholder="Digite o tipo de atividade"
              className="w-full border border-slate-300 rounded-lg px-2.5 py-1.5 text-sm mt-1.5"
            />
          )}
        </div>
      </div>

      <div className="grid grid-cols-2 sm:grid-cols-4 gap-3 mb-4">
        <div>
          <label className="text-xs text-slate-500 mb-1 block">Duração (min)</label>
          <input type="number" step="1" value={form.durationMin} onChange={(e) => setField("durationMin", e.target.value)} placeholder="Opcional" className="w-full border border-slate-300 rounded-lg px-2.5 py-1.5 text-sm" />
        </div>
        <div>
          <label className="text-xs text-slate-500 mb-1 block">Intensidade</label>
          <select value={form.intensity} onChange={(e) => setField("intensity", e.target.value)} className="w-full border border-slate-300 rounded-lg px-2.5 py-1.5 text-sm">
            <option value="">Não informar</option>
            <option value="leve">Leve</option>
            <option value="moderada">Moderada</option>
            <option value="intensa">Intensa</option>
          </select>
        </div>
        <div>
          <label className="text-xs text-slate-500 mb-1 block">Distância (km)</label>
          <input type="number" step="0.1" value={form.distanceKm} onChange={(e) => setField("distanceKm", e.target.value)} placeholder="Opcional" className="w-full border border-slate-300 rounded-lg px-2.5 py-1.5 text-sm" />
        </div>
        <div>
          <label className="text-xs text-slate-500 mb-1 block">Calorias (kcal)</label>
          <input type="number" step="1" value={form.caloriesKcal} onChange={(e) => setField("caloriesKcal", e.target.value)} placeholder="Opcional" className="w-full border border-slate-300 rounded-lg px-2.5 py-1.5 text-sm" />
        </div>
      </div>

      <div className="mb-4">
        <label className="text-xs text-slate-500 mb-1 block">Notas (opcional)</label>
        <textarea value={form.notes} onChange={(e) => setField("notes", e.target.value)} rows={2} className="w-full border border-slate-300 rounded-lg px-2.5 py-1.5 text-sm resize-none" />
      </div>

      {error && (
        <div className="mb-4 flex items-start gap-2 text-sm text-red-700 bg-red-50 border border-red-200 rounded-lg px-3 py-2.5">
          <AlertTriangle size={15} className="mt-0.5 shrink-0" /> {error}
        </div>
      )}

      <div className="flex justify-end gap-2">
        <button onClick={onCancel} className="text-sm px-3 py-2 rounded-lg text-slate-500 hover:bg-slate-100">Cancelar</button>
        <button
          disabled={!form.date || !finalType || saving}
          onClick={handleSave}
          className="flex items-center gap-1.5 text-sm px-3.5 py-2 rounded-lg bg-slate-900 text-white disabled:opacity-40 hover:bg-slate-800"
        >
          {saving && <Loader2 size={14} className="animate-spin" />}
          {saving ? "Salvando..." : "Salvar atividade"}
        </button>
      </div>
    </ModalShell>
  );
}

function ActivityIntegrations({ profileId, onSynced }) {
  const [stravaStatus, setStravaStatus] = useState(null);
  const [stravaSyncing, setStravaSyncing] = useState(false);
  const [stravaError, setStravaError] = useState(null);
  const [stravaMsg, setStravaMsg] = useState(null);

  const [webhookUrl, setWebhookUrl] = useState(null);
  const [copied, setCopied] = useState(false);
  const [showInstructions, setShowInstructions] = useState(false);
  const [confirmReset, setConfirmReset] = useState(false);

  useEffect(() => {
    api.getStravaStatus(profileId).then(setStravaStatus).catch(() => setStravaStatus({ connected: false }));
    api.getActivityWebhook(profileId).then((d) => setWebhookUrl(d.url)).catch(() => {});
  }, [profileId]);

  const syncStrava = async () => {
    setStravaSyncing(true);
    setStravaError(null);
    setStravaMsg(null);
    try {
      const data = await api.syncStrava(profileId);
      setStravaMsg(`${data.imported} atividade${data.imported !== 1 ? "s" : ""} nova${data.imported !== 1 ? "s" : ""} importada${data.imported !== 1 ? "s" : ""}.`);
      await onSynced();
    } catch (e) {
      setStravaError(e.message || "Erro ao sincronizar com o Strava.");
    } finally {
      setStravaSyncing(false);
    }
  };

  const disconnectStrava = async () => {
    await api.disconnectStrava(profileId);
    setStravaStatus({ connected: false });
    setStravaMsg(null);
  };

  const copyWebhook = async () => {
    try {
      await navigator.clipboard.writeText(webhookUrl);
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    } catch (e) {}
  };

  const resetWebhook = async () => {
    const data = await api.resetActivityWebhook(profileId);
    setWebhookUrl(data.url);
    setConfirmReset(false);
  };

  return (
    <div className="grid grid-cols-1 sm:grid-cols-2 gap-3 mb-6">
      {/* Strava */}
      <div className="border border-slate-200 rounded-xl p-4">
        <p className="text-xs font-medium text-slate-400 uppercase tracking-wide mb-2">Strava</p>
        {stravaStatus === null ? (
          <Loader2 size={16} className="animate-spin text-slate-300" />
        ) : stravaStatus.connected ? (
          <div>
            <p className="text-sm text-emerald-700 flex items-center gap-1.5 mb-2"><CheckCircle2 size={14} /> Conectado</p>
            <div className="flex items-center gap-3">
              <button onClick={syncStrava} disabled={stravaSyncing} className="text-sm px-3 py-1.5 rounded-lg bg-slate-900 text-white hover:bg-slate-800 disabled:opacity-50 flex items-center gap-1.5">
                {stravaSyncing ? <Loader2 size={13} className="animate-spin" /> : <RefreshCw size={13} />}
                Sincronizar
              </button>
              <button onClick={disconnectStrava} className="text-xs text-slate-400 hover:text-red-500 underline">Desconectar</button>
            </div>
            {stravaMsg && <p className="text-xs text-slate-500 mt-2">{stravaMsg}</p>}
            {stravaError && <p className="text-xs text-red-600 mt-2">{stravaError}</p>}
          </div>
        ) : (
          <div>
            <p className="text-xs text-slate-500 mb-2">Sincronize corridas, pedaladas e outros treinos automaticamente.</p>
            <a href={api.stravaConnectUrl(profileId)} className="inline-flex items-center gap-1.5 text-sm px-3 py-1.5 rounded-lg bg-orange-600 text-white hover:bg-orange-700">
              <Link size={13} /> Conectar com Strava
            </a>
          </div>
        )}
      </div>

      {/* Apple Watch */}
      <div className="border border-slate-200 rounded-xl p-4">
        <p className="text-xs font-medium text-slate-400 uppercase tracking-wide mb-2 flex items-center gap-1.5"><Watch size={12} /> Apple Watch</p>
        <p className="text-xs text-slate-500 mb-2">Envie treinos automaticamente com um Atalho do iPhone.</p>
        {webhookUrl ? (
          <div>
            <div className="flex items-center gap-2 mb-2">
              <code className="text-xs bg-slate-50 border border-slate-200 rounded px-2 py-1 truncate flex-1">{webhookUrl}</code>
              <button onClick={copyWebhook} className="text-slate-400 hover:text-slate-700 p-1.5 shrink-0" aria-label="Copiar link">
                <Copy size={14} />
              </button>
            </div>
            <div className="flex items-center gap-3">
              <button onClick={() => setShowInstructions((v) => !v)} className="text-xs text-slate-500 hover:text-slate-800 underline">
                {showInstructions ? "Ocultar instruções" : "Como configurar"}
              </button>
              <button onClick={() => setConfirmReset(true)} className="text-xs text-slate-400 hover:text-red-500 underline">Gerar novo link</button>
            </div>
            {copied && <p className="text-xs text-emerald-600 mt-1">Link copiado!</p>}
            {showInstructions && (
              <ol className="text-xs text-slate-500 mt-2 space-y-1 list-decimal list-inside">
                <li>No iPhone, abra o app <strong>Atalhos</strong> → aba Automação → Nova Automação → "Treino Concluído".</li>
                <li>Adicione a ação "Obter Detalhes do Treino" (ou "Detalhes de Saúde") pra pegar duração, distância e calorias.</li>
                <li>Adicione "Obter Conteúdo de URL": método POST, corpo JSON com os campos <code>date</code>, <code>activityType</code>, <code>durationMin</code>, <code>distanceKm</code>, <code>caloriesKcal</code>.</li>
                <li>Cole o link acima como a URL da requisição.</li>
                <li>Desative "Perguntar antes de executar" pra rodar sozinho depois do treino.</li>
              </ol>
            )}
          </div>
        ) : (
          <Loader2 size={16} className="animate-spin text-slate-300" />
        )}
      </div>

      {confirmReset && (
        <ConfirmModal
          title="Gerar novo link do Apple Watch?"
          message="O link atual vai parar de funcionar. Você vai precisar atualizar o Atalho do iPhone com o novo link."
          confirmLabel="Gerar novo link"
          onCancel={() => setConfirmReset(false)}
          onConfirm={resetWebhook}
        />
      )}
    </div>
  );
}

function MiniSparkline({ points, color = "#0f766e" }) {
  if (!points || points.length < 2) {
    return <div className="h-10 flex items-center text-xs text-slate-300">sem histórico suficiente</div>;
  }
  return (
    <ResponsiveContainer width="100%" height={40}>
      <LineChart data={points}>
        <Line type="monotone" dataKey="value" stroke={color} strokeWidth={2} dot={false} isAnimationActive={false} />
      </LineChart>
    </ResponsiveContainer>
  );
}

function WeeklyBars({ days }) {
  const max = Math.max(1, ...days.map((d) => d.minutes));
  return (
    <div className="flex items-end gap-1.5 h-12">
      {days.map((d, i) => (
        <div key={i} className="flex-1 flex flex-col items-center gap-1">
          <div className="w-full bg-slate-100 rounded-sm overflow-hidden flex items-end" style={{ height: "36px" }}>
            <div
              className="w-full bg-rose-400 rounded-sm"
              style={{ height: `${Math.round((d.minutes / max) * 100)}%`, transition: "height 0.6s ease-out" }}
            />
          </div>
          <span className="text-[9px] text-slate-400">{d.label}</span>
        </div>
      ))}
    </div>
  );
}

function DashboardCard({ title, onClick, children }) {
  return (
    <button onClick={onClick} className="text-left bg-white border border-slate-200 rounded-xl p-4 hover:border-slate-300 hover:shadow-sm transition">
      <p className="text-xs font-medium text-slate-400 uppercase tracking-wide mb-2">{title}</p>
      {children}
    </button>
  );
}

function DashboardScreen({ profileId, profileName, profile, onGoTo }) {
  const [loading, setLoading] = useState(true);
  const [index, setIndex] = useState([]);
  const [batches, setBatches] = useState({});
  const [bodyEntries, setBodyEntries] = useState([]);
  const [symptoms, setSymptoms] = useState([]);
  const [activities, setActivities] = useState([]);

  useEffect(() => {
    (async () => {
      setLoading(true);
      const idx = await api.getBatchIndex(profileId);
      const loadedBatches = {};
      await Promise.all(idx.map(async (b) => { loadedBatches[b.batchId] = await api.getBatch(profileId, b.batchId); }));
      const [body, syms, acts] = await Promise.all([
        api.getBodyEntries(profileId),
        api.getSymptoms(profileId),
        api.getActivities(profileId),
      ]);
      setIndex(idx);
      setBatches(loadedBatches);
      setBodyEntries(body);
      setSymptoms(syms);
      setActivities(acts);
      setLoading(false);
    })();
  }, [profileId]);

  if (loading) {
    return <div className="flex justify-center py-16 text-slate-400"><Loader2 className="animate-spin" size={22} /></div>;
  }

  const orderedBatchIds = index.map((b) => b.batchId); // já vem do servidor ordenado do mais recente pro mais antigo
  // O "Score de saúde" precisa refletir TODOS os exames já feitos (mesma lógica da aba Exames:
  // o valor mais recente de cada exame, não só os exames do último laudo). Antes disso, se o
  // laudo mais recente tivesse poucos exames (ex: só 2 de rotina), o score saía de lá mesmo
  // que outros exames alterados estivessem em laudos anteriores — dando um número enganoso.
  // Para o histórico do gráfico, recalculamos o score "acumulado até aquele laudo" a cada
  // ponto, pra mostrar a evolução de forma consistente com o valor atual.
  const batchIdsAsc = orderedBatchIds.slice().reverse();
  const scoreHistory = [];
  for (let i = 0; i < batchIdsAsc.length; i++) {
    const idsUpToHereDesc = batchIdsAsc.slice(0, i + 1).reverse();
    const mergedSoFar = mergeLatestExamResults(idsUpToHereDesc, batches);
    const score = computeScore(mergedSoFar);
    const batch = batches[batchIdsAsc[i]];
    if (score !== null && batch) scoreHistory.push({ date: batch.date, value: score });
  }
  const latestScore = scoreHistory.length ? scoreHistory[scoreHistory.length - 1].value : null;
  const scoreTrend = scoreHistory.length >= 2 ? scoreHistory[scoreHistory.length - 1].value - scoreHistory[scoreHistory.length - 2].value : null;

  const withImcEntries = withImc(bodyEntries, profile?.heightCm);
  // Mesma correção da aba Saúde física: pega o valor mais recente de CADA item, não só os
  // campos que vieram na última medição cadastrada (que podia não ter peso, por exemplo).
  const latestBody = withImcEntries.length ? mergeLatestBodyFields(withImcEntries, profile?.heightCm) : null;
  const weightHistory = withImcEntries
    .filter((e) => e.weightKg !== null && e.weightKg !== undefined)
    .map((e) => ({ date: e.date, value: e.weightKg }));
  const [, prevWeight] = latestTwoValues(withImcEntries, "weightKg");
  const weightTrend = latestBody?.weightKg != null && prevWeight != null
    ? Math.round((latestBody.weightKg - prevWeight) * 10) / 10 : null;

  const last7Days = Array.from({ length: 7 }, (_, i) => {
    const d = new Date();
    d.setDate(d.getDate() - (6 - i));
    const iso = d.toISOString().slice(0, 10);
    const minutes = activities.filter((a) => a.date === iso).reduce((s, a) => s + (a.durationMin || 0), 0);
    return { label: "DSTQQSS"[d.getDay()], minutes, iso };
  });
  const weeklyMinutes = last7Days.reduce((s, d) => s + d.minutes, 0);

  const activeSymptoms = symptoms.filter((s) => s.status !== "resolvido").sort((a, b) => (b.date || "").localeCompare(a.date || ""));

  const examTrends = computeExamTrends(orderedBatchIds, batches, 180);

  const latestBatchMeta = index.length ? index.slice().sort((a, b) => (b.date || "").localeCompare(a.date || ""))[0] : null;

  return (
    <div>
      {latestBatchMeta && (
        <div className="grid grid-cols-1 sm:grid-cols-2 gap-3 mb-6">
          <ScoreCard score={latestScore} trend={scoreTrend} />
          <CountCard
            label="Última coleta"
            value={fmtDate(latestBatchMeta.date)}
            sub={[compactLabName(latestBatchMeta.lab), latestBatchMeta.doctor ? `Solicitante: ${latestBatchMeta.doctor}` : null].filter(Boolean).join(" · ") || "Laboratório não informado"}
          />
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
              <Line type="monotone" dataKey="value" stroke="#0f766e" strokeWidth={2} dot={{ r: 3 }} />
            </LineChart>
          </ResponsiveContainer>
        </div>
      )}

      <div className="grid grid-cols-1 sm:grid-cols-3 gap-3 mb-4">
        <DashboardCard title="Saúde física" onClick={() => onGoTo("corpo")}>
          <div className="flex items-end gap-2 mb-1">
            <span className="text-2xl font-medium text-slate-900">
              {latestBody?.weightKg ?? "—"}<span className="text-sm text-slate-400 ml-1">kg</span>
            </span>
            {weightTrend !== null && weightTrend !== 0 && (
              <span className={`flex items-center text-xs mb-1 ${weightTrend > 0 ? "text-amber-600" : "text-emerald-600"}`}>
                {weightTrend > 0 ? <TrendingUp size={12} /> : <TrendingDown size={12} />} {Math.abs(weightTrend)}
              </span>
            )}
          </div>
          <MiniSparkline points={weightHistory} color="#fb7185" />
        </DashboardCard>

        <DashboardCard title="Atividade da semana" onClick={() => onGoTo("atividades")}>
          <div className="flex items-end gap-2 mb-2">
            <span className="text-2xl font-medium text-slate-900">{weeklyMinutes}</span>
            <span className="text-sm text-slate-400 mb-1">min</span>
          </div>
          <WeeklyBars days={last7Days} />
        </DashboardCard>

        <DashboardCard title="Sintomas ativos" onClick={() => onGoTo("sintomas")}>
          <div className="flex items-end gap-2 mb-2">
            <span className="text-2xl font-medium text-slate-900">{activeSymptoms.length}</span>
          </div>
          {activeSymptoms.length === 0 ? (
            <p className="text-xs text-slate-400">Nenhum sintoma ativo</p>
          ) : (
            <div className="space-y-1">
              {activeSymptoms.slice(0, 2).map((s) => (
                <p key={s.id} className="text-xs text-slate-500 truncate">{s.description}</p>
              ))}
            </div>
          )}
        </DashboardCard>

        <DashboardCard
          title="Exames que melhoraram"
          onClick={() => onGoTo("exames", { examNames: examTrends.improved, label: "Exames que melhoraram (180 dias)" })}
        >
          <div className="flex items-end gap-2 mb-2">
            <TrendingUp size={16} className="text-emerald-600 mb-1" />
            <span className="text-2xl font-medium text-slate-900">{examTrends.improved.length}</span>
            <span className="text-xs text-slate-400 mb-1">últimos 180 dias</span>
          </div>
          {examTrends.improved.length === 0 ? (
            <p className="text-xs text-slate-400">Nenhuma melhora registrada no período</p>
          ) : (
            <div className="space-y-1">
              {examTrends.improved.slice(0, 2).map((name, i) => (
                <p key={i} className="text-xs text-slate-500 truncate">{name}</p>
              ))}
            </div>
          )}
        </DashboardCard>

        <DashboardCard
          title="Exames que pioraram"
          onClick={() => onGoTo("exames", { examNames: examTrends.worsened, label: "Exames que pioraram (180 dias)" })}
        >
          <div className="flex items-end gap-2 mb-2">
            <TrendingDown size={16} className="text-red-600 mb-1" />
            <span className="text-2xl font-medium text-slate-900">{examTrends.worsened.length}</span>
            <span className="text-xs text-slate-400 mb-1">últimos 180 dias</span>
          </div>
          {examTrends.worsened.length === 0 ? (
            <p className="text-xs text-slate-400">Nenhuma piora registrada no período</p>
          ) : (
            <div className="space-y-1">
              {examTrends.worsened.slice(0, 2).map((name, i) => (
                <p key={i} className="text-xs text-slate-500 truncate">{name}</p>
              ))}
            </div>
          )}
        </DashboardCard>
      </div>

      {!latestBatchMeta && !latestBody && !activeSymptoms.length && weeklyMinutes === 0 && (
        <p className="text-sm text-slate-400 text-center mt-6">
          Ainda não há nada registrado para {profileName}. Comece por um exame, uma medição ou uma atividade.
        </p>
      )}
    </div>
  );
}

// ---------- Invoices (Notas fiscais / IR) ----------

function InvoicesPanel({ profileId, pendingReview, onConsumePendingReview, onWaUploadResolved }) {
  const [invoices, setInvoices] = useState(null);
  const [year, setYear] = useState("");
  const [uploading, setUploading] = useState(false);
  const [uploadError, setUploadError] = useState(null);
  const [reviewData, setReviewData] = useState(null);
  const [reviewFromWaId, setReviewFromWaId] = useState(null);
  const [confirmDelete, setConfirmDelete] = useState(null);
  const fileInputRef = useRef(null);

  const load = useCallback(async () => {
    const list = await api.getInvoices(profileId);
    setInvoices(list);
  }, [profileId]);

  useEffect(() => { load(); }, [load]);

  // Chega aqui quando o usuário clica "Revisar" numa nota fiscal recebida pelo WhatsApp
  // (fila de pendências, controlada pela ProfileScreen).
  useEffect(() => {
    if (pendingReview) {
      setReviewData(pendingReview.data);
      setReviewFromWaId(pendingReview.uploadId);
      onConsumePendingReview();
    }
  }, [pendingReview, onConsumePendingReview]);

  const years = useMemo(
    () => [...new Set((invoices || []).map((i) => (i.date || "").slice(0, 4)).filter(Boolean))].sort().reverse(),
    [invoices]
  );

  useEffect(() => {
    if (!year && years.length) setYear(years[0]);
  }, [years, year]);

  const handleFile = async (file) => {
    setUploadError(null);
    setUploading(true);
    try {
      if (file.size > 8 * 1024 * 1024) {
        throw new Error("Esse PDF passa de 8MB — tente um arquivo menor.");
      }
      const parsed = await api.extractInvoice(profileId, file);
      setReviewData({
        date: parsed.d || new Date().toISOString().slice(0, 10),
        provider: parsed.prov || "",
        doc: parsed.doc || "",
        value: parsed.v ?? "",
        description: parsed.desc || "",
        category: parsed.cat || "Outro",
        base64: parsed.base64,
        fileName: parsed.fileName,
        hash: parsed.hash,
      });
    } catch (e) {
      if (e.duplicate) {
        setUploadError(`Essa nota já foi importada antes (${fmtDate(e.dupInfo.date)}, ${e.dupInfo.provider || "prestador não informado"}). Não vou importar de novo para não duplicar.`);
      } else if (e.notInvoice) {
        setUploadError(e.message || "Esse arquivo não parece ser uma nota fiscal ou recibo. Envie apenas notas fiscais, NFS-e, recibos ou faturas de despesas médicas/odontológicas.");
      } else {
        setUploadError(e.message || "Não consegui ler esse PDF. Tente novamente.");
      }
    } finally {
      setUploading(false);
    }
  };

  const saveInvoiceHandler = async (data) => {
    try {
      const saved = await api.saveInvoice(profileId, data);
      setInvoices((prev) => [saved, ...(prev || [])].sort((a, b) => (b.date || "").localeCompare(a.date || "")));
      setReviewData(null);
      if (reviewFromWaId) {
        await api.deleteWhatsappUpload(profileId, reviewFromWaId);
        setReviewFromWaId(null);
        if (onWaUploadResolved) onWaUploadResolved();
      }
    } catch (e) {
      if (e.duplicate) {
        setUploadError(`Essa nota já está salva (${fmtDate(e.dupInfo.date)}, ${e.dupInfo.provider || "prestador não informado"}). Não vou salvar de novo para não duplicar.`);
        setReviewData(null);
      } else {
        throw e;
      }
    }
  };

  const removeInvoice = async (id) => {
    await api.deleteInvoice(profileId, id);
    setInvoices((prev) => (prev || []).filter((i) => i.id !== id));
  };

  if (invoices === null) {
    return <div className="flex justify-center py-16 text-slate-400"><Loader2 className="animate-spin" size={22} /></div>;
  }

  const filtered = invoices.filter((i) => !year || (i.date || "").startsWith(year));
  const total = filtered.reduce((s, i) => s + (i.value || 0), 0);
  const byCategory = {};
  for (const i of filtered) {
    byCategory[i.category || "Outro"] = (byCategory[i.category || "Outro"] || 0) + (i.value || 0);
  }

  return (
    <div>
      <div className="flex items-center justify-between mb-4 flex-wrap gap-2">
        <div className="flex items-center gap-2">
          <label className="text-xs text-slate-500">Ano:</label>
          <select value={year} onChange={(e) => setYear(e.target.value)} className="border border-slate-300 rounded-lg text-sm px-2 py-1.5">
            {years.length === 0 && <option value="">—</option>}
            {years.map((y) => <option key={y} value={y}>{y}</option>)}
          </select>
        </div>
        <div className="flex items-center gap-2">
          <input ref={fileInputRef} type="file" accept="application/pdf" className="hidden" onChange={(e) => { const f = e.target.files?.[0]; if (f) handleFile(f); e.target.value = ""; }} />
          <button onClick={() => fileInputRef.current?.click()} disabled={uploading} className="flex items-center gap-1.5 bg-slate-900 text-white text-sm font-medium px-3.5 py-2 rounded-lg hover:bg-slate-800 disabled:opacity-50">
            {uploading ? <Loader2 size={15} className="animate-spin" /> : <Upload size={15} />}
            {uploading ? "Lendo PDF..." : "Enviar nota fiscal"}
          </button>
        </div>
      </div>

      {uploadError && (
        <div className="mb-4 flex items-start gap-2 text-sm text-red-700 bg-red-50 border border-red-200 rounded-lg px-3 py-2.5">
          <AlertTriangle size={16} className="mt-0.5 shrink-0" />
          <div className="flex-1">{uploadError}</div>
          {!uploadError.startsWith("Essa nota já") && (
            <button
              onClick={() => setReviewData({ date: new Date().toISOString().slice(0, 10), provider: "", doc: "", value: "", description: "", category: "Outro", base64: null })}
              className="text-xs underline whitespace-nowrap"
            >
              Adicionar manualmente
            </button>
          )}
        </div>
      )}

      <div className="grid grid-cols-1 sm:grid-cols-2 gap-3 mb-6">
        <div className="bg-slate-50 rounded-xl p-4">
          <p className="text-xs text-slate-500 mb-1">Total dedutível {year && `em ${year}`}</p>
          <p className="text-2xl font-medium text-slate-900">{fmtBRL(total)}</p>
        </div>
        <div className="bg-slate-50 rounded-xl p-4">
          <p className="text-xs text-slate-500 mb-1.5">Por categoria</p>
          <div className="flex flex-wrap gap-1.5">
            {Object.keys(byCategory).length === 0 && <span className="text-xs text-slate-400">Nenhuma nota fiscal ainda</span>}
            {Object.entries(byCategory).map(([cat, v]) => (
              <span key={cat} className="text-xs bg-white border border-slate-200 rounded-full px-2 py-1 text-slate-600">
                {cat}: {fmtBRL(v)}
              </span>
            ))}
          </div>
        </div>
      </div>

      {filtered.length === 0 ? (
        <div className="border border-dashed border-slate-300 rounded-xl py-14 text-center text-slate-400">
          <Receipt size={28} className="mx-auto mb-2" />
          <p className="text-sm">Nenhuma nota fiscal ainda. Envie o PDF de uma nota, recibo ou fatura de despesa médica/odontológica.</p>
        </div>
      ) : (
        <div className="mt-2">
          <p className="text-sm font-medium text-slate-700 mb-2">Notas fiscais guardadas</p>
          <div className="border border-slate-200 rounded-xl divide-y divide-slate-100">
            {filtered.map((inv) => (
              <div key={inv.id} className="flex items-center justify-between px-4 py-2.5 gap-3 flex-wrap">
                <div className="flex items-center gap-2.5 min-w-0">
                  <Receipt size={15} className="text-slate-400 shrink-0" />
                  <span className="text-sm text-slate-800 whitespace-nowrap">{fmtDate(inv.date)}</span>
                  <span className="text-xs text-slate-400 truncate">
                    {inv.provider || "Prestador não informado"} · {inv.category || "Outro"} · {fmtBRL(inv.value)}
                  </span>
                </div>
                <div className="flex items-center gap-1 shrink-0">
                  {inv.hasPdf ? (
                    <a href={api.invoicePdfUrl(profileId, inv.id)} target="_blank" rel="noreferrer" className="text-slate-400 hover:text-slate-700 p-1.5 inline-flex" aria-label="Abrir/baixar documento original">
                      <FileText size={15} />
                    </a>
                  ) : (
                    <span className="text-slate-200 p-1.5 inline-flex" title="Sem documento anexado"><FileText size={15} /></span>
                  )}
                  <button onClick={() => setConfirmDelete(inv)} className="text-slate-300 hover:text-red-500 p-1.5" aria-label="Excluir nota">
                    <Trash2 size={15} />
                  </button>
                </div>
              </div>
            ))}
          </div>
        </div>
      )}

      <p className="text-xs text-slate-400 mt-3 flex items-start gap-1.5">
        <Info size={13} className="mt-0.5 shrink-0" />
        A categorização é gerada automaticamente e pode errar — confirme sempre com um contador antes de declarar.
      </p>

      {confirmDelete && (
        <ConfirmModal
          title="Excluir esta nota?"
          message="A nota fiscal e os dados extraídos dela serão removidos."
          confirmLabel="Excluir"
          onCancel={() => setConfirmDelete(null)}
          onConfirm={() => { removeInvoice(confirmDelete.id); setConfirmDelete(null); }}
        />
      )}

      {reviewData && <ReviewInvoiceModal data={reviewData} onCancel={() => { setReviewData(null); setReviewFromWaId(null); }} onConfirm={saveInvoiceHandler} />}
    </div>
  );
}

function ReviewInvoiceModal({ data, onCancel, onConfirm }) {
  const [date, setDate] = useState(data.date || "");
  const [provider, setProvider] = useState(data.provider || "");
  const [doc, setDoc] = useState(data.doc || "");
  const [value, setValue] = useState(data.value ?? "");
  const [category, setCategory] = useState(data.category || "Outro");
  const [description, setDescription] = useState(data.description || "");

  return (
    <ModalShell onClose={onCancel} title="Confira os dados da nota">
      <p className="text-xs text-slate-500 mb-3 flex items-center gap-1.5">
        <ClipboardEdit size={13} /> Revise e corrija antes de salvar — a leitura automática pode errar.
      </p>
      <div className="grid grid-cols-2 gap-3 mb-3">
        <div>
          <label className="text-xs text-slate-500 mb-1 block">Data</label>
          <input type="date" value={date} onChange={(e) => setDate(e.target.value)} className="w-full border border-slate-300 rounded-lg px-2.5 py-1.5 text-sm" />
        </div>
        <div>
          <label className="text-xs text-slate-500 mb-1 block">Valor (R$)</label>
          <input type="number" step="0.01" value={value} onChange={(e) => setValue(e.target.value)} className="w-full border border-slate-300 rounded-lg px-2.5 py-1.5 text-sm" />
        </div>
      </div>
      <div className="mb-3">
        <label className="text-xs text-slate-500 mb-1 block">Prestador / estabelecimento</label>
        <input value={provider} onChange={(e) => setProvider(e.target.value)} className="w-full border border-slate-300 rounded-lg px-2.5 py-1.5 text-sm" />
      </div>
      <div className="grid grid-cols-2 gap-3 mb-3">
        <div>
          <label className="text-xs text-slate-500 mb-1 block">CPF/CNPJ do prestador</label>
          <input value={doc} onChange={(e) => setDoc(e.target.value)} className="w-full border border-slate-300 rounded-lg px-2.5 py-1.5 text-sm" />
        </div>
        <div>
          <label className="text-xs text-slate-500 mb-1 block">Categoria</label>
          <select value={category} onChange={(e) => setCategory(e.target.value)} className="w-full border border-slate-300 rounded-lg px-2.5 py-1.5 text-sm">
            {INVOICE_CATEGORIES.map((c) => <option key={c} value={c}>{c}</option>)}
          </select>
        </div>
      </div>
      <div className="mb-4">
        <label className="text-xs text-slate-500 mb-1 block">Descrição</label>
        <input value={description} onChange={(e) => setDescription(e.target.value)} placeholder="Opcional" className="w-full border border-slate-300 rounded-lg px-2.5 py-1.5 text-sm" />
      </div>
      <div className="flex justify-end gap-2">
        <button onClick={onCancel} className="text-sm px-3 py-2 rounded-lg text-slate-500 hover:bg-slate-100">Cancelar</button>
        <button
          disabled={!date || value === "" || value === null}
          onClick={() => onConfirm({ date, provider, doc, value: parseFloat(value) || 0, category, description, base64: data.base64, fileName: data.fileName, hash: data.hash })}
          className="text-sm px-3.5 py-2 rounded-lg bg-slate-900 text-white disabled:opacity-40 hover:bg-slate-800"
        >
          Salvar
        </button>
      </div>
    </ModalShell>
  );
}
