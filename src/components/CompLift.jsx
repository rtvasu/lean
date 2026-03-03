import { useState, useCallback, useRef, useEffect } from "react";

// ─── PROMPT ──────────────────────────────────────────────────────────────────
const EXTRACTION_PROMPT = `You are an expert at extracting executive compensation data from Canadian Annual Information Circulars (AICs) and management proxy circulars filed on SEDAR.

Extract ALL executive compensation data from this document. Look specifically for the Summary Compensation Table (SCT) or equivalent Named Executive Officers (NEO) table. Extract EVERY fiscal year present in the table — AICs often show 2–3 years of historical data side by side.

For each executive × fiscal year combination found, extract:
- name, title, fiscal_year (4-digit string e.g. "2023")
- base_salary, short_term_incentive, long_term_incentive, other_compensation, total_compensation

For each monetary value provide:
- value: number in CAD (or null if not found)
- confidence: "high", "medium", or "low"
- source_page: integer page number
- flag_reason: string explaining uncertainty if confidence is medium/low, else null

Also extract at the document level:
- company_name, fiscal_year_end (YYYY-MM-DD), currency (usually "CAD"), document_notes (any important structural notes about the comp program, or null)

IMPORTANT: If the table shows 3 years of data for the CEO, return 3 separate entries in the executives array — one per year.

Respond ONLY with valid JSON, no preamble, no markdown fences:

{
  "company_name": "string",
  "fiscal_year_end": "string",
  "currency": "CAD",
  "document_notes": "string or null",
  "executives": [
    {
      "name": "string",
      "title": "string",
      "fiscal_year": "string",
      "base_salary": { "value": number|null, "confidence": "high|medium|low", "source_page": number, "flag_reason": "string or null" },
      "short_term_incentive": { "value": number|null, "confidence": "high|medium|low", "source_page": number, "flag_reason": "string or null" },
      "long_term_incentive": { "value": number|null, "confidence": "high|medium|low", "source_page": number, "flag_reason": "string or null" },
      "other_compensation": { "value": number|null, "confidence": "high|medium|low", "source_page": number, "flag_reason": "string or null" },
      "total_compensation": { "value": number|null, "confidence": "high|medium|low", "source_page": number, "flag_reason": "string or null" }
    }
  ]
}`;

// ─── CONSTANTS ────────────────────────────────────────────────────────────────
const FIELDS = [
  { key: "base_salary", label: "Base Salary", short: "Base" },
  { key: "short_term_incentive", label: "STI / Bonus", short: "STI" },
  { key: "long_term_incentive", label: "LTI", short: "LTI" },
  { key: "other_compensation", label: "Other", short: "Other" },
  { key: "total_compensation", label: "Total", short: "Total" },
];
const STATUS = { PENDING: "pending", EXTRACTING: "extracting", DONE: "done", ERROR: "error" };

// ─── HELPERS ──────────────────────────────────────────────────────────────────
const fmt = (v) => v == null ? "—" : new Intl.NumberFormat("en-CA", { style: "currency", currency: "CAD", minimumFractionDigits: 0, maximumFractionDigits: 0 }).format(v);

const confStyle = (c, reviewed) => {
  if (reviewed) return { bg: "rgba(34,197,94,0.07)", border: "#1a4a2a", text: "#4ade80", dot: "#22c55e" };
  if (c === "high") return { bg: "transparent", border: "transparent", text: "#9b9b8e", dot: "#22c55e" };
  if (c === "medium") return { bg: "rgba(245,158,11,0.07)", border: "#4a3200", text: "#fbbf24", dot: "#f59e0b" };
  return { bg: "rgba(239,68,68,0.07)", border: "#4a1010", text: "#f87171", dot: "#ef4444" };
};

const pctChange = (a, b) => {
  if (!a || !b || a === 0) return null;
  return ((b - a) / a * 100).toFixed(1);
};

function classifyError(err, context) {
  const msg = (err?.message || String(err) || "Unknown error").trim();
  const raw = context ? `${msg}\n\nContext: ${context}` : msg;

  if (msg.includes("401") || msg.includes("authentication") || msg.includes("api_key") || msg.includes("API key")) {
    return { title: "Authentication Failed", detail: "The Anthropic API key is missing or invalid.", hint: "Click the key icon in the header to enter your Anthropic API key.", raw };
  }
  if (msg.includes("429") || msg.includes("rate_limit") || msg.includes("rate limit")) {
    return { title: "Rate Limit Reached", detail: "Too many requests sent to the Anthropic API.", hint: "Wait a moment and try uploading again. Documents in a batch are queued sequentially to reduce this.", raw };
  }
  if (msg.includes("413") || msg.includes("too large") || msg.includes("file size") || msg.includes("request_too_large")) {
    return { title: "File Too Large", detail: "This PDF exceeds the maximum size the API accepts.", hint: "Try splitting the document into smaller parts or reducing the PDF file size.", raw };
  }
  if (msg.includes("529") || msg.includes("overloaded")) {
    return { title: "API Overloaded", detail: "Anthropic's servers are temporarily overloaded.", hint: "Wait a minute and retry. This is usually transient.", raw };
  }
  if (msg.includes("network") || msg.includes("fetch") || msg.includes("Failed to fetch") || msg.includes("ECONNREFUSED")) {
    return { title: "Network Error", detail: "Could not reach the Anthropic API.", hint: "Check your internet connection and try again.", raw };
  }
  if (msg.includes("JSON") || msg.includes("Unexpected token") || msg.includes("parse")) {
    return { title: "Unexpected Response", detail: "The API returned a response that couldn't be parsed as structured data.", hint: "This may happen with unusual PDF formatting. Try re-uploading or check if the document contains a readable compensation table.", raw };
  }
  if (msg.includes("invalid_request") || msg.includes("400")) {
    return { title: "Invalid Request", detail: "The API rejected the request.", hint: "The PDF may be encrypted, corrupted, or in an unsupported format.", raw };
  }
  return { title: "Extraction Failed", detail: msg, hint: "Check that the file is a valid, readable PDF containing a compensation table.", raw };
}

async function extractFile(file, apiKey) {
  let base64;
  try {
    base64 = await new Promise((res, rej) => {
      const r = new FileReader();
      r.onload = () => res(r.result.split(",")[1]);
      r.onerror = () => rej(new Error("Failed to read file. The file may be corrupted or inaccessible."));
      r.readAsDataURL(file);
    });
  } catch (err) {
    const e = classifyError(err, "Reading file from disk");
    throw Object.assign(new Error(e.title), { classified: e });
  }

  let response, data;
  try {
    response = await fetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-api-key": apiKey,
        "anthropic-version": "2023-06-01",
        "anthropic-dangerous-direct-browser-access": "true",
      },
      body: JSON.stringify({
        model: "claude-sonnet-4-20250514",
        max_tokens: 4000,
        messages: [{
          role: "user",
          content: [
            { type: "document", source: { type: "base64", media_type: "application/pdf", data: base64 } },
            { type: "text", text: EXTRACTION_PROMPT }
          ]
        }]
      })
    });
  } catch (err) {
    const e = classifyError(err, "Sending request to Anthropic API");
    throw Object.assign(new Error(e.title), { classified: e });
  }

  try {
    data = await response.json();
  } catch (err) {
    const e = classifyError(new Error(`HTTP ${response.status}: Could not parse API response`), "Parsing API response");
    throw Object.assign(new Error(e.title), { classified: e });
  }

  if (data.error) {
    const e = classifyError(new Error(data.error.message || JSON.stringify(data.error)), `API error type: ${data.error.type}`);
    throw Object.assign(new Error(e.title), { classified: e });
  }

  const raw = data.content.map(i => i.text || "").join("").replace(/```json|```/g, "").trim();
  try {
    return JSON.parse(raw);
  } catch (err) {
    const e = classifyError(new Error("JSON parse failed: " + err.message), `Raw response snippet: ${raw.slice(0, 120)}`);
    throw Object.assign(new Error(e.title), { classified: e });
  }
}

function Dot({ confidence, reviewed }) {
  const s = confStyle(confidence, reviewed);
  return <span style={{ display: "inline-block", width: 6, height: 6, borderRadius: "50%", backgroundColor: s.dot, marginRight: 5, flexShrink: 0 }} />;
}

function MiniBar({ values }) {
  const valid = values.filter(v => v != null);
  if (valid.length < 2) return null;
  const max = Math.max(...valid);
  return (
    <div style={{ display: "flex", alignItems: "flex-end", gap: 2, height: 18 }}>
      {values.map((v, i) => (
        <div key={i} style={{
          width: 7, borderRadius: "2px 2px 0 0",
          height: v ? `${Math.max(15, (v / max) * 100)}%` : "8%",
          backgroundColor: i === values.length - 1 ? "#22c55e" : "#1e2e1e",
          transition: "height 0.4s ease",
        }} />
      ))}
    </div>
  );
}

export default function CompLift() {
  const [jobs, setJobs] = useState([]);
  const [selectedJob, setSelectedJob] = useState(null);
  const [activeFlag, setActiveFlag] = useState(null);
  const [activeExec, setActiveExec] = useState(null);
  const [dragOver, setDragOver] = useState(false);
  const [hoveredError, setHoveredError] = useState(null); // { jobId, rect }
  const [copied, setCopied] = useState(false);
  const [apiKey, setApiKey] = useState(() => localStorage.getItem("cl_anthropic_key") || "");
  const [showKeyModal, setShowKeyModal] = useState(false);
  const [keyDraft, setKeyDraft] = useState("");
  const [showKey, setShowKey] = useState(false);
  const fileInputRef = useRef();
  const idRef = useRef(0);

  useEffect(() => {
    if (!apiKey) setShowKeyModal(true);
  }, []);

  const saveKey = () => {
    const trimmed = keyDraft.trim();
    if (!trimmed) return;
    localStorage.setItem("cl_anthropic_key", trimmed);
    setApiKey(trimmed);
    setKeyDraft("");
    setShowKey(false);
    setShowKeyModal(false);
  };

  const openKeyModal = () => {
    setKeyDraft("");
    setShowKey(false);
    setShowKeyModal(true);
  };

  const addFiles = useCallback(async (files) => {
    if (!apiKey) { openKeyModal(); return; }
    const arr = Array.from(files).filter(f => f.type === "application/pdf");
    const newJobs = arr.map(f => ({
      id: ++idRef.current, file: f,
      status: STATUS.PENDING, data: null, editedData: null,
      reviewedFlags: new Set(), error: null,
    }));
    setJobs(prev => [...prev, ...newJobs]);

    for (const job of newJobs) {
      setJobs(prev => prev.map(j => j.id === job.id ? { ...j, status: STATUS.EXTRACTING } : j));
      try {
        const data = await extractFile(job.file, apiKey);
        setJobs(prev => {
          const updated = prev.map(j => j.id === job.id ? {
            ...j, status: STATUS.DONE, data,
            editedData: JSON.parse(JSON.stringify(data)),
            reviewedFlags: new Set()
          } : j);
          return updated;
        });
        setSelectedJob(prev => prev ?? job.id);
      } catch (err) {
        const classified = err.classified ?? classifyError(err, null);
        setJobs(prev => prev.map(j => j.id === job.id ? { ...j, status: STATUS.ERROR, error: classified } : j));
      }
    }
  }, [apiKey]);

  const handleDrop = useCallback((e) => {
    e.preventDefault(); setDragOver(false);
    addFiles(e.dataTransfer.files);
  }, [addFiles]);

  const updateCell = (jobId, execIdx, field, rawVal) => {
    setJobs(prev => prev.map(j => {
      if (j.id !== jobId) return j;
      const next = JSON.parse(JSON.stringify(j.editedData));
      next.executives[execIdx][field].value = rawVal === "" ? null : parseFloat(rawVal.replace(/[^0-9.]/g, ""));
      next.executives[execIdx][field].confidence = "high";
      const r = new Set(j.reviewedFlags); r.add(`${execIdx}-${field}`);
      return { ...j, editedData: next, reviewedFlags: r };
    }));
    setActiveFlag(null);
  };

  const markReviewed = (jobId, execIdx, field) => {
    setJobs(prev => prev.map(j => {
      if (j.id !== jobId) return j;
      const r = new Set(j.reviewedFlags); r.add(`${execIdx}-${field}`);
      return { ...j, reviewedFlags: r };
    }));
    setActiveFlag(null);
  };

  const exportCSV = (job) => {
    const d = job.editedData;
    const headers = ["Company","Fiscal Year End","Name","Title","Fiscal Year","Base Salary","STI/Bonus","LTI","Other","Total","Currency"];
    const rows = d.executives.map(e => [
      d.company_name, d.fiscal_year_end, e.name, e.title, e.fiscal_year,
      e.base_salary?.value ?? "", e.short_term_incentive?.value ?? "",
      e.long_term_incentive?.value ?? "", e.other_compensation?.value ?? "",
      e.total_compensation?.value ?? "", d.currency
    ]);
    const csv = [headers, ...rows].map(r => r.map(v => `"${v}"`).join(",")).join("\n");
    const a = document.createElement("a");
    a.href = URL.createObjectURL(new Blob([csv], { type: "text/csv" }));
    a.download = `${d.company_name?.replace(/\s+/g, "_") ?? "comp"}_compensation.csv`;
    a.click();
  };

  const exportAll = () => {
    const done = jobs.filter(j => j.status === STATUS.DONE);
    const headers = ["Company","Fiscal Year End","Name","Title","Fiscal Year","Base Salary","STI/Bonus","LTI","Other","Total","Currency"];
    const rows = done.flatMap(job => job.editedData.executives.map(e => [
      job.editedData.company_name, job.editedData.fiscal_year_end,
      e.name, e.title, e.fiscal_year,
      e.base_salary?.value ?? "", e.short_term_incentive?.value ?? "",
      e.long_term_incentive?.value ?? "", e.other_compensation?.value ?? "",
      e.total_compensation?.value ?? "", job.editedData.currency
    ]));
    const csv = [headers, ...rows].map(r => r.map(v => `"${v}"`).join(",")).join("\n");
    const a = document.createElement("a");
    a.href = URL.createObjectURL(new Blob([csv], { type: "text/csv" }));
    a.download = `complift_all.csv`; a.click();
  };

  const selJob = jobs.find(j => j.id === selectedJob);
  const curData = selJob?.editedData;

  const allFlags = curData ? curData.executives.flatMap((exec, ei) =>
    FIELDS.filter(({ key }) => {
      const c = exec[key]?.confidence;
      return (c === "medium" || c === "low") && !selJob.reviewedFlags.has(`${ei}-${key}`);
    }).map(({ key }) => ({ execIdx: ei, field: key }))
  ) : [];

  const canExport = selJob?.status === STATUS.DONE && allFlags.length === 0;
  const activeFlagData = activeFlag && curData ? curData.executives[activeFlag.execIdx]?.[activeFlag.field] : null;

  return (
    <>
    <div style={{ minHeight: "100vh", display: "flex", flexDirection: "column", backgroundColor: "#07070e", color: "#d8d5cf", fontFamily: "'DM Mono','Fira Code','Courier New',monospace" }}>
      <style>{`
        @import url('https://fonts.googleapis.com/css2?family=DM+Mono:ital,wght@0,300;0,400;0,500;1,300&family=Syne:wght@700;800&display=swap');
        *{box-sizing:border-box;margin:0;padding:0}
        ::-webkit-scrollbar{width:3px;height:3px}
        ::-webkit-scrollbar-thumb{background:#1e1e2a;border-radius:2px}
        @keyframes pulse{0%,100%{opacity:1}50%{opacity:.3}}
        @keyframes fadeUp{from{opacity:0;transform:translateY(10px)}to{opacity:1;transform:translateY(0)}}
        @keyframes slideIn{from{opacity:0;transform:translateX(10px)}to{opacity:1;transform:translateX(0)}}
        .jrow:hover{background:#0c0c15!important}
        .cbtn:hover{filter:brightness(1.15)}
        .frow:hover{background:#0f0f18!important}
        .exec-hdr:hover{background:#0c140c!important}
      `}</style>

      {/* ── HEADER ── */}
      <header style={{ height: 52, display: "flex", alignItems: "center", padding: "0 24px", borderBottom: "1px solid #13131e", backgroundColor: "rgba(7,7,14,.92)", backdropFilter: "blur(12px)", position: "sticky", top: 0, zIndex: 200, gap: 16, flexShrink: 0 }}>
        <div style={{ fontFamily: "'Syne',sans-serif", fontSize: 17, fontWeight: 800, letterSpacing: "-0.03em" }}>
          Comp<span style={{ color: "#22c55e" }}>Lift</span>
        </div>
        <div style={{ width: 1, height: 18, background: "#1e1e2a" }} />
        <div style={{ fontSize: 10, color: "#7a7a8e", letterSpacing: "0.12em", textTransform: "uppercase" }}>Executive Compensation Intelligence</div>
        <div style={{ marginLeft: "auto", display: "flex", gap: 8, alignItems: "center" }}>
          {jobs.filter(j => j.status === STATUS.DONE).length > 1 && (
            <button onClick={exportAll} style={{ padding: "6px 12px", borderRadius: 5, border: "1px solid #1e1e2a", background: "transparent", color: "#6b6b7e", fontSize: 10, fontFamily: "inherit", fontWeight: 700, letterSpacing: "0.08em", textTransform: "uppercase", cursor: "pointer" }}>
              Export All ↓
            </button>
          )}
          <button
            onClick={openKeyModal}
            title={apiKey ? "API key set — click to change" : "Set Anthropic API key"}
            style={{ padding: "6px 10px", borderRadius: 5, border: `1px solid ${apiKey ? "#1e2e1e" : "#4a3200"}`, background: apiKey ? "transparent" : "rgba(245,158,11,0.07)", color: apiKey ? "#22c55e" : "#f59e0b", fontSize: 13, cursor: "pointer", lineHeight: 1 }}
          >
            {apiKey ? "🔑" : "⚠ Set API Key"}
          </button>
          <button onClick={() => fileInputRef.current.click()} style={{ padding: "6px 14px", borderRadius: 5, border: "none", background: "#16a34a", color: "#fff", fontSize: 10, fontFamily: "inherit", fontWeight: 700, letterSpacing: "0.08em", textTransform: "uppercase", cursor: "pointer" }}>
            + Upload AICs
          </button>
          <input ref={fileInputRef} type="file" accept=".pdf" multiple style={{ display: "none" }} onChange={e => addFiles(e.target.files)} />
        </div>
      </header>

      <div style={{ display: "flex", flex: 1, overflow: "hidden", height: "calc(100vh - 52px)" }}>

        {/* ── SIDEBAR ── */}
        <aside style={{ width: 240, flexShrink: 0, borderRight: "1px solid #13131e", overflowY: "auto", backgroundColor: "#090912", display: "flex", flexDirection: "column" }}>
          <div style={{ padding: "12px 14px 6px", fontSize: 9, color: "#7a7a8e", letterSpacing: "0.14em", textTransform: "uppercase", fontWeight: 700 }}>
            Documents · {jobs.length}
          </div>

          {jobs.length === 0 && (
            <div style={{ padding: "20px 14px", fontSize: 11, color: "#6a6a7a", lineHeight: 1.8 }}>No documents yet.</div>
          )}

          {jobs.map(job => {
            const isSel = job.id === selectedJob;
            const pending = job.editedData ? job.editedData.executives.flatMap((e, ei) =>
              FIELDS.filter(({ key }) => (e[key]?.confidence === "medium" || e[key]?.confidence === "low") && !job.reviewedFlags.has(`${ei}-${key}`))
            ).length : 0;
            const years = job.data ? [...new Set(job.data.executives.map(e => e.fiscal_year))].sort() : [];
            const execCount = job.data ? [...new Set(job.data.executives.map(e => e.name))].length : 0;

            return (
              <div key={job.id} className="jrow"
                onClick={() => { if (job.status === STATUS.DONE) { setSelectedJob(job.id); setActiveFlag(null); setActiveExec(null); } }}
                onMouseEnter={job.status === STATUS.ERROR ? (e) => {
                  const rect = e.currentTarget.getBoundingClientRect();
                  setHoveredError({ jobId: job.id, rect });
                } : undefined}
                onMouseLeave={job.status === STATUS.ERROR ? () => setHoveredError(null) : undefined}
                style={{ padding: "10px 14px", cursor: job.status === STATUS.DONE ? "pointer" : "default", backgroundColor: isSel ? "#0b150b" : "transparent", borderLeft: `2px solid ${isSel ? "#22c55e" : job.status === STATUS.ERROR ? "#4a1010" : "transparent"}`, borderBottom: "1px solid #0e0e16", transition: "all .15s", position: "relative" }}>
                <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", gap: 6 }}>
                  <div style={{ fontSize: 11, color: job.status === STATUS.ERROR ? "#f87171" : isSel ? "#d8d5cf" : "#7b7b8e", fontWeight: 600, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap", flex: 1 }}>
                    {job.data?.company_name ?? job.file.name.replace(".pdf", "")}
                  </div>
                  {job.status === STATUS.EXTRACTING && <span style={{ fontSize: 8, color: "#f59e0b", animation: "pulse 1.2s infinite", flexShrink: 0 }}>READING</span>}
                  {job.status === STATUS.DONE && pending > 0 && <span style={{ fontSize: 8, background: "#251a00", color: "#f59e0b", border: "1px solid #4a3200", borderRadius: 3, padding: "1px 4px", flexShrink: 0 }}>{pending}</span>}
                  {job.status === STATUS.DONE && pending === 0 && <span style={{ fontSize: 9, color: "#22c55e", flexShrink: 0 }}>✓</span>}
                  {job.status === STATUS.ERROR && <span style={{ fontSize: 8, color: "#f87171", border: "1px solid #4a1010", borderRadius: 3, padding: "1px 5px", flexShrink: 0, cursor: "default" }}>ERR</span>}
                </div>
                {years.length > 0 && (
                  <div style={{ fontSize: 9, color: "#6a7a6a", marginTop: 3 }}>{years.join(", ")} · {execCount} execs</div>
                )}
                {job.status === STATUS.ERROR && (
                  <div style={{ fontSize: 9, color: "#6a2a2a", marginTop: 3 }}>Hover for details</div>
                )}
              </div>
            );
          })}

          {/* Drop zone */}
          <div onDragOver={e => { e.preventDefault(); setDragOver(true); }} onDragLeave={() => setDragOver(false)} onDrop={handleDrop}
            onClick={() => fileInputRef.current.click()}
            style={{ margin: "10px 10px 10px", borderRadius: 7, border: `1px dashed ${dragOver ? "#22c55e" : "#1e1e2a"}`, padding: "12px 8px", textAlign: "center", cursor: "pointer", backgroundColor: dragOver ? "#0b190b" : "transparent", transition: "all .2s", marginTop: "auto" }}>
            <div style={{ fontSize: 14, marginBottom: 3 }}>⬆</div>
            <div style={{ fontSize: 9, color: "#7a7a8e" }}>Drop PDFs</div>
          </div>
        </aside>

        {/* ── MAIN ── */}
        <main style={{ flex: 1, overflowY: "auto", padding: "26px 28px" }}>

          {jobs.length === 0 && (
            <div style={{ display: "flex", flexDirection: "column", alignItems: "center", justifyContent: "center", height: "100%", animation: "fadeUp .4s ease", textAlign: "center" }}>
              <div style={{ fontSize: 52, marginBottom: 18, opacity: .15 }}>⬆</div>
              <h1 style={{ fontFamily: "'Syne',sans-serif", fontSize: 26, fontWeight: 800, letterSpacing: "-0.04em", marginBottom: 10 }}>Drop AICs to begin</h1>
              <p style={{ color: "#7a7a8e", fontSize: 12, maxWidth: 360, lineHeight: 1.8 }}>
                Upload one or more Annual Information Circulars from SEDAR. CompLift extracts every year of executive compensation data, flags uncertain values for your review, and exports clean structured CSV.
              </p>
              {!apiKey && (
                <button onClick={openKeyModal} style={{ marginTop: 24, padding: "11px 22px", borderRadius: 6, border: "1px solid #4a3200", background: "rgba(245,158,11,0.07)", color: "#f59e0b", fontSize: 11, fontFamily: "inherit", fontWeight: 700, letterSpacing: "0.08em", textTransform: "uppercase", cursor: "pointer" }}>
                  ⚠ Set Anthropic API Key First
                </button>
              )}
              <button onClick={() => fileInputRef.current.click()} style={{ marginTop: apiKey ? 24 : 10, padding: "11px 22px", borderRadius: 6, border: "none", background: "#16a34a", color: "#fff", fontSize: 11, fontFamily: "inherit", fontWeight: 700, letterSpacing: "0.08em", textTransform: "uppercase", cursor: "pointer" }}>
                + Upload AICs
              </button>
            </div>
          )}

          {jobs.length > 0 && !curData && (
            <div style={{ color: "#7a7a8e", fontSize: 12, paddingTop: 40 }}>
              {jobs.some(j => j.status === STATUS.EXTRACTING) ? "Extracting… results will appear in the sidebar as each document finishes." : "Select a completed document from the sidebar."}
            </div>
          )}

          {curData && (() => {
            const years = [...new Set(curData.executives.map(e => e.fiscal_year))].sort();
            const activeYear = activeExec && years.includes(activeExec) ? activeExec : years[years.length - 1];
            // All unique exec names across all years (union), sorted by first appearance
            const allExecNames = [...new Map(
              curData.executives.map(e => [e.name, e.title])
            ).entries()];
            // Execs present in the active year tab
            const yearExecs = curData.executives
              .map((e, idx) => ({ ...e, _idx: idx }))
              .filter(e => e.fiscal_year === activeYear);
            const yearExecMap = Object.fromEntries(yearExecs.map(e => [e.name, e]));
            // Count missing fields across active year
            const missingCount = allExecNames.reduce((acc, [name]) => {
              const exec = yearExecMap[name];
              if (!exec) return acc + FIELDS.length;
              return acc + FIELDS.filter(({ key }) => exec[key]?.value == null).length;
            }, 0);

            return (
              <div style={{ animation: "fadeUp .3s ease" }}>
                {/* Company header */}
                <div style={{ display: "flex", alignItems: "flex-start", justifyContent: "space-between", flexWrap: "wrap", gap: 12, marginBottom: 18 }}>
                  <div>
                    <h2 style={{ fontFamily: "'Syne',sans-serif", fontSize: 20, fontWeight: 800, letterSpacing: "-0.03em", marginBottom: 4 }}>{curData.company_name}</h2>
                    <div style={{ fontSize: 10, color: "#7a7a8e" }}>
                      {curData.fiscal_year_end && `FY End ${curData.fiscal_year_end} · `}
                      {curData.currency} · {allExecNames.length} executives
                    </div>
                  </div>
                  <div style={{ display: "flex", gap: 8, alignItems: "center", flexWrap: "wrap" }}>
                    {/* Web scrape button — stub, no functionality */}
                    {missingCount > 0 && (
                      <button
                        onClick={() => {}}
                        title="Coming soon: auto-fill missing data from public sources"
                        style={{
                          display: "flex", alignItems: "center", gap: 6,
                          padding: "7px 13px", borderRadius: 5,
                          border: "1px solid #4a3200",
                          background: "rgba(245,158,11,0.06)",
                          color: "#f59e0b", fontSize: 10, fontFamily: "inherit",
                          fontWeight: 700, letterSpacing: "0.07em", textTransform: "uppercase",
                          cursor: "not-allowed", opacity: 0.85,
                        }}
                      >
                        <span style={{ fontSize: 11 }}>⟳</span>
                        Web Scrape Missing ({missingCount})
                      </button>
                    )}
                    <button onClick={() => exportCSV(selJob)} style={{ padding: "7px 14px", borderRadius: 5, border: "none", background: canExport ? "#16a34a" : "#111120", color: canExport ? "#fff" : "#7a7a8e", fontSize: 10, fontFamily: "inherit", fontWeight: 700, letterSpacing: "0.08em", textTransform: "uppercase", cursor: canExport ? "pointer" : "not-allowed" }}>
                      Export CSV ↓
                    </button>
                  </div>
                </div>

                {curData.document_notes && (
                  <div style={{ background: "#0c0c18", border: "1px solid #1e1e2a", borderRadius: 7, padding: "9px 13px", marginBottom: 18, fontSize: 11, color: "#5a5a6e", lineHeight: 1.7 }}>
                    <span style={{ color: "#22c55e", marginRight: 6 }}>ℹ</span>{curData.document_notes}
                  </div>
                )}

                {/* ── YEAR TABS ── */}
                <div style={{ display: "flex", gap: 0, marginBottom: 0, borderBottom: "1px solid #13131e" }}>
                  {years.map((y, i) => {
                    const isActive = y === activeYear;
                    const isLatest = i === years.length - 1;
                    // Count missing in this year tab for badge
                    const tabMissing = allExecNames.reduce((acc, [name]) => {
                      const exec = curData.executives.find(e => e.fiscal_year === y && e.name === name);
                      if (!exec) return acc + FIELDS.length;
                      return acc + FIELDS.filter(({ key }) => exec[key]?.value == null).length;
                    }, 0);
                    return (
                      <button
                        key={y}
                        onClick={() => setActiveExec(y)}
                        style={{
                          padding: "10px 18px", border: "none", borderBottom: isActive ? "2px solid #22c55e" : "2px solid transparent",
                          background: "transparent", fontFamily: "inherit", fontSize: 12, fontWeight: isActive ? 700 : 400,
                          color: isActive ? "#d8d5cf" : "#7a7a8e", cursor: "pointer",
                          display: "flex", alignItems: "center", gap: 7,
                          transition: "color .15s, border-color .15s",
                          marginBottom: "-1px",
                        }}
                      >
                        {y}
                        {isLatest && <span style={{ fontSize: 8, background: "#0d2b1a", color: "#4ade80", border: "1px solid #1a5c35", borderRadius: 3, padding: "1px 5px", fontWeight: 700, letterSpacing: "0.06em" }}>LATEST</span>}
                        {tabMissing > 0 && (
                          <span style={{ fontSize: 8, background: "rgba(245,158,11,0.1)", color: "#f59e0b", border: "1px solid #4a3200", borderRadius: 3, padding: "1px 5px" }}>{tabMissing} N/A</span>
                        )}
                      </button>
                    );
                  })}
                </div>

                {/* ── YEAR TABLE ── */}
                <div style={{ background: "#09090f", border: "1px solid #13131e", borderTop: "none", borderRadius: "0 0 9px 9px", overflow: "hidden" }}>
                  <div style={{ overflowX: "auto" }}>
                    <table style={{ width: "100%", borderCollapse: "collapse", fontSize: 12 }}>
                      <thead>
                        <tr style={{ borderBottom: "1px solid #13131e" }}>
                          <th style={{ textAlign: "left", padding: "10px 18px", fontSize: 9, color: "#7a7a8e", letterSpacing: "0.1em", textTransform: "uppercase", fontWeight: 600, whiteSpace: "nowrap" }}>Executive</th>
                          {FIELDS.map(f => (
                            <th key={f.key} style={{ textAlign: "right", padding: "10px 14px", fontSize: 9, color: "#7a7a8e", letterSpacing: "0.1em", textTransform: "uppercase", fontWeight: 600, whiteSpace: "nowrap" }}>{f.label}</th>
                          ))}
                        </tr>
                      </thead>
                      <tbody>
                        {allExecNames.map(([name, titleFallback]) => {
                          const exec = yearExecMap[name];
                          const execPresent = !!exec;

                          return (
                            <tr key={name} style={{ borderBottom: "1px solid #0c0c12" }}>
                              {/* Name cell */}
                              <td style={{ padding: "11px 18px", minWidth: 180 }}>
                                <div style={{ fontSize: 12, fontWeight: 600, color: execPresent ? "#d8d5cf" : "#6b6b7e", marginBottom: 1 }}>{name}</div>
                                <div style={{ fontSize: 9, color: "#7a7a8e" }}>{exec?.title ?? titleFallback}</div>
                              </td>

                              {/* Field cells */}
                              {FIELDS.map(({ key }) => {
                                if (!execPresent) {
                                  return (
                                    <td key={key} style={{ textAlign: "right", padding: "9px 14px" }}>
                                      <span style={{ fontSize: 11, color: "#b45309", background: "rgba(180,83,9,0.08)", border: "1px solid rgba(180,83,9,0.2)", borderRadius: 4, padding: "2px 7px" }}>N/A</span>
                                    </td>
                                  );
                                }
                                const cell = exec[key];
                                const ei = exec._idx;
                                const ck = `${ei}-${key}`;
                                const reviewed = selJob.reviewedFlags.has(ck);
                                const isFlag = cell && (cell.confidence === "medium" || cell.confidence === "low") && !reviewed;
                                const isActive = activeFlag?.execIdx === ei && activeFlag?.field === key;
                                const s = cell ? confStyle(cell.confidence, reviewed) : null;
                                const isNull = !cell || cell.value == null;

                                return (
                                  <td key={key} style={{ textAlign: "right", padding: "7px 14px" }}>
                                    {isNull ? (
                                      <span style={{ fontSize: 11, color: "#b45309", background: "rgba(180,83,9,0.08)", border: "1px solid rgba(180,83,9,0.2)", borderRadius: 4, padding: "2px 7px" }}>N/A</span>
                                    ) : (
                                      <button className="cbtn"
                                        onClick={() => isFlag ? setActiveFlag({ execIdx: ei, field: key }) : null}
                                        style={{ display: "inline-flex", alignItems: "center", justifyContent: "flex-end", background: s.bg, border: `1px solid ${isActive ? s.border : s.border}`, borderRadius: 4, padding: "3px 7px", cursor: isFlag ? "pointer" : "default", fontFamily: "inherit", fontSize: 11, color: s.text, whiteSpace: "nowrap", transition: "filter .15s" }}>
                                        {reviewed ? <span style={{ color: "#22c55e", marginRight: 4, fontSize: 8 }}>✓</span> : <Dot confidence={cell.confidence} reviewed={reviewed} />}
                                        {fmt(cell.value)}
                                      </button>
                                    )}
                                  </td>
                                );
                              })}
                            </tr>
                          );
                        })}
                      </tbody>
                    </table>
                  </div>

                  {/* Legend */}
                  <div style={{ padding: "10px 18px", borderTop: "1px solid #0c0c12", display: "flex", gap: 20, flexWrap: "wrap" }}>
                    {[
                      { dot: "#22c55e", label: "High confidence" },
                      { dot: "#f59e0b", label: "Needs review" },
                      { dot: "#ef4444", label: "Low confidence" },
                    ].map(({ dot, label }) => (
                      <div key={label} style={{ display: "flex", alignItems: "center", gap: 5, fontSize: 10, color: "#7a7a8e" }}>
                        <span style={{ width: 6, height: 6, borderRadius: "50%", backgroundColor: dot, display: "inline-block" }} />{label}
                      </div>
                    ))}
                    <div style={{ display: "flex", alignItems: "center", gap: 5, fontSize: 10, color: "#7a7a8e" }}>
                      <span style={{ fontSize: 10, color: "#b45309" }}>N/A</span> Not available — requires manual lookup
                    </div>
                  </div>
                </div>
              </div>
            );
          })()}
        </main>

        {/* ── RIGHT PANEL ── */}
        {selJob?.status === STATUS.DONE && (
          <aside style={{ width: 272, flexShrink: 0, borderLeft: "1px solid #13131e", overflowY: "auto", background: "#090912", padding: 18 }}>
            {activeFlag && activeFlagData ? (
              <div style={{ animation: "slideIn .2s ease" }}>
                <div style={{ display: "flex", justifyContent: "space-between", marginBottom: 14 }}>
                  <div style={{ fontSize: 9, color: "#7a7a8e", letterSpacing: "0.12em", textTransform: "uppercase", fontWeight: 700 }}>Flag Review</div>
                  <button onClick={() => setActiveFlag(null)} style={{ background: "none", border: "none", color: "#7a7a8e", cursor: "pointer", fontFamily: "inherit", fontSize: 13 }}>✕</button>
                </div>

                <div style={{ marginBottom: 12 }}>
                  <div style={{ fontSize: 12, color: "#d8d5cf", fontWeight: 700, marginBottom: 2 }}>{curData.executives[activeFlag.execIdx].name}</div>
                  <div style={{ fontSize: 9, color: "#7a7a8e" }}>
                    {FIELDS.find(f => f.key === activeFlag.field)?.label}
                    {activeFlagData.source_page && ` · pg ${activeFlagData.source_page}`}
                    {` · ${curData.executives[activeFlag.execIdx].fiscal_year}`}
                  </div>
                </div>

                <div style={{ background: confStyle(activeFlagData.confidence, false).bg, border: `1px solid ${confStyle(activeFlagData.confidence, false).border}`, borderRadius: 7, padding: 11, marginBottom: 14 }}>
                  <div style={{ display: "flex", alignItems: "center", marginBottom: activeFlagData.flag_reason ? 5 : 0 }}>
                    <Dot confidence={activeFlagData.confidence} reviewed={false} />
                    <span style={{ fontSize: 9, color: confStyle(activeFlagData.confidence, false).text, fontWeight: 700, letterSpacing: "0.08em", textTransform: "uppercase" }}>{activeFlagData.confidence} confidence</span>
                  </div>
                  {activeFlagData.flag_reason && <div style={{ fontSize: 10, color: "#5a5a6e", lineHeight: 1.7 }}>{activeFlagData.flag_reason}</div>}
                </div>

                <div style={{ marginBottom: 12 }}>
                  <div style={{ fontSize: 9, color: "#7a7a8e", letterSpacing: "0.1em", textTransform: "uppercase", marginBottom: 5 }}>Edit Value (CAD)</div>
                  <input key={`${activeFlag.execIdx}-${activeFlag.field}`} defaultValue={activeFlagData.value ?? ""} placeholder="Corrected value"
                    onBlur={e => updateCell(selectedJob, activeFlag.execIdx, activeFlag.field, e.target.value)}
                    style={{ width: "100%", background: "#0c0c18", border: "1px solid #1e1e2a", borderRadius: 5, padding: "7px 9px", color: "#d8d5cf", fontFamily: "inherit", fontSize: 12 }} />
                </div>

                <button onClick={() => markReviewed(selectedJob, activeFlag.execIdx, activeFlag.field)}
                  style={{ width: "100%", padding: "9px", borderRadius: 5, border: "none", background: "#16a34a", color: "#fff", fontSize: 10, fontFamily: "inherit", fontWeight: 700, letterSpacing: "0.08em", textTransform: "uppercase", cursor: "pointer", marginBottom: 6 }}>
                  ✓ Mark Reviewed
                </button>

                {allFlags.length > 1 && (
                  <button onClick={() => { const n = allFlags.find(f => !(f.execIdx === activeFlag.execIdx && f.field === activeFlag.field)); if (n) setActiveFlag(n); }}
                    style={{ width: "100%", padding: "7px", borderRadius: 5, border: "1px solid #1e1e2a", background: "transparent", color: "#4a4a5a", fontSize: 10, fontFamily: "inherit", cursor: "pointer" }}>
                    Next Flag →
                  </button>
                )}
              </div>
            ) : allFlags.length > 0 ? (
              <div>
                <div style={{ fontSize: 9, color: "#7a7a8e", letterSpacing: "0.12em", textTransform: "uppercase", fontWeight: 700, marginBottom: 12 }}>
                  {allFlags.length} Flag{allFlags.length !== 1 ? "s" : ""} Pending
                </div>
                {allFlags.map(({ execIdx, field }) => {
                  const exec = curData.executives[execIdx];
                  const cell = exec[field];
                  const s = confStyle(cell.confidence, false);
                  return (
                    <button key={`${execIdx}-${field}`} className="frow"
                      onClick={() => setActiveFlag({ execIdx, field })}
                      style={{ display: "flex", alignItems: "center", width: "100%", textAlign: "left", background: "#0c0c18", border: `1px solid ${s.border}`, borderRadius: 5, padding: "7px 9px", marginBottom: 5, cursor: "pointer", gap: 8, fontFamily: "inherit", transition: "background .15s" }}>
                      <Dot confidence={cell.confidence} reviewed={false} />
                      <div style={{ flex: 1, minWidth: 0 }}>
                        <div style={{ fontSize: 11, color: "#b8b5af", fontWeight: 600, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{exec.name}</div>
                        <div style={{ fontSize: 9, color: "#7a7a8e" }}>{FIELDS.find(f => f.key === field)?.label} · {exec.fiscal_year}</div>
                      </div>
                      <div style={{ fontSize: 10, color: s.text, flexShrink: 0 }}>{cell.value != null ? fmt(cell.value) : "—"}</div>
                    </button>
                  );
                })}
                <button onClick={() => setActiveFlag(allFlags[0])}
                  style={{ width: "100%", padding: "9px", borderRadius: 5, border: "none", background: "#16a34a", color: "#fff", fontSize: 10, fontFamily: "inherit", fontWeight: 700, letterSpacing: "0.08em", textTransform: "uppercase", cursor: "pointer", marginTop: 8 }}>
                  Start Review →
                </button>
              </div>
            ) : (
              <div style={{ textAlign: "center", paddingTop: 36 }}>
                <div style={{ fontSize: 26, marginBottom: 8 }}>✓</div>
                <div style={{ fontSize: 11, fontWeight: 700, color: "#4ade80", marginBottom: 5 }}>All clear</div>
                <div style={{ fontSize: 10, color: "#7a7a8e", lineHeight: 1.7, marginBottom: 18 }}>No flags pending.<br />Ready to export.</div>
                <button onClick={() => exportCSV(selJob)}
                  style={{ width: "100%", padding: "9px", borderRadius: 5, border: "none", background: "#16a34a", color: "#fff", fontSize: 10, fontFamily: "inherit", fontWeight: 700, letterSpacing: "0.08em", textTransform: "uppercase", cursor: "pointer" }}>
                  Export CSV ↓
                </button>
              </div>
            )}
          </aside>
        )}
      </div>

      {/* ── ERROR TOOLTIP PORTAL ── */}
      {hoveredError && (() => {
        const job = jobs.find(j => j.id === hoveredError.jobId);
        if (!job || !job.error) return null;
        const err = job.error;
        const { rect } = hoveredError;
        const top = Math.min(rect.top, window.innerHeight - 280);
        const copyText = `Error: ${err.title}\n\nDetail: ${err.detail}\n\nHint: ${err.hint}\n\nFull error: ${err.raw}`;

        return (
          <div
            onMouseEnter={() => {}}
            onMouseLeave={() => setHoveredError(null)}
            style={{
              position: "fixed",
              top: top,
              left: rect.right + 8,
              width: 300,
              backgroundColor: "#0f0f18",
              border: "1px solid #4a1010",
              borderRadius: 9,
              padding: 16,
              zIndex: 1000,
              boxShadow: "0 8px 32px rgba(0,0,0,.6), 0 0 0 1px rgba(239,68,68,.08)",
              animation: "slideIn .15s ease",
            }}
          >
            {/* Header */}
            <div style={{ display: "flex", alignItems: "flex-start", gap: 10, marginBottom: 12 }}>
              <span style={{ fontSize: 14, marginTop: 1 }}>⚠</span>
              <div style={{ flex: 1 }}>
                <div style={{ fontSize: 12, fontWeight: 700, color: "#f87171", marginBottom: 2 }}>{err.title}</div>
                <div style={{ fontSize: 10, color: "#5a3a3a" }}>{job.file.name}</div>
              </div>
            </div>

            {/* Detail */}
            <div style={{ fontSize: 11, color: "#9a8a8a", lineHeight: 1.7, marginBottom: 10, padding: "8px 10px", background: "#0c0c14", borderRadius: 5, border: "1px solid #2a1a1a" }}>
              {err.detail}
            </div>

            {/* Hint */}
            <div style={{ display: "flex", gap: 7, marginBottom: 14 }}>
              <span style={{ fontSize: 10, color: "#4a4a5a", flexShrink: 0, marginTop: 1 }}>→</span>
              <div style={{ fontSize: 10, color: "#4a4a5a", lineHeight: 1.6 }}>{err.hint}</div>
            </div>

            {/* Raw error (collapsed) */}
            {err.raw && err.raw !== err.detail && (
              <details style={{ marginBottom: 12 }}>
                <summary style={{ fontSize: 9, color: "#7a7a8e", cursor: "pointer", letterSpacing: "0.08em", textTransform: "uppercase", userSelect: "none", marginBottom: 5 }}>
                  Raw error
                </summary>
                <div style={{ fontSize: 9, color: "#7a7a8e", fontFamily: "monospace", lineHeight: 1.6, padding: "6px 8px", background: "#080810", borderRadius: 4, border: "1px solid #1a1a26", wordBreak: "break-all", maxHeight: 80, overflowY: "auto" }}>
                  {err.raw}
                </div>
              </details>
            )}

            {/* Copy button */}
            <button
              onClick={() => {
                navigator.clipboard.writeText(copyText).then(() => {
                  setCopied(true);
                  setTimeout(() => setCopied(false), 2000);
                });
              }}
              style={{
                width: "100%", padding: "7px", borderRadius: 5,
                border: `1px solid ${copied ? "#1a5c35" : "#2a1a1a"}`,
                background: copied ? "#0d2b1a" : "#0c0c14",
                color: copied ? "#4ade80" : "#5a4a4a",
                fontSize: 10, fontFamily: "inherit", fontWeight: 700,
                letterSpacing: "0.08em", textTransform: "uppercase",
                cursor: "pointer", transition: "all .2s",
              }}
            >
              {copied ? "✓ Copied" : "Copy Error"}
            </button>
          </div>
        );
      })()}
    </div>

    {/* ── API KEY MODAL ── */}
    {showKeyModal && (
      <div
        onClick={(e) => { if (e.target === e.currentTarget && apiKey) setShowKeyModal(false); }}
        style={{ position: "fixed", inset: 0, background: "rgba(0,0,0,.7)", backdropFilter: "blur(4px)", zIndex: 1000, display: "flex", alignItems: "center", justifyContent: "center", padding: 24 }}
      >
        <div style={{ background: "#0d0d18", border: "1px solid #1e1e2a", borderRadius: 10, padding: "28px 28px 24px", width: "100%", maxWidth: 420, animation: "fadeUp .2s ease" }}>
          <div style={{ fontFamily: "'Syne',sans-serif", fontSize: 16, fontWeight: 800, letterSpacing: "-0.03em", marginBottom: 6 }}>
            Anthropic API Key
          </div>
          <p style={{ fontSize: 11, color: "#7a7a8e", lineHeight: 1.8, marginBottom: 20 }}>
            Your key is stored only in this browser's <code style={{ color: "#9b9b8e" }}>localStorage</code> and sent directly to Anthropic. It never touches any server.
            {" "}Get a key at <span style={{ color: "#22c55e" }}>console.anthropic.com</span>.
          </p>
          <div style={{ position: "relative", marginBottom: 12 }}>
            <input
              type={showKey ? "text" : "password"}
              value={keyDraft}
              onChange={e => setKeyDraft(e.target.value)}
              onKeyDown={e => { if (e.key === "Enter") saveKey(); if (e.key === "Escape" && apiKey) setShowKeyModal(false); }}
              placeholder="sk-ant-..."
              autoFocus
              style={{ width: "100%", padding: "10px 40px 10px 12px", borderRadius: 6, border: "1px solid #2a2a3a", background: "#080810", color: "#d8d5cf", fontSize: 12, fontFamily: "inherit", outline: "none", letterSpacing: "0.02em" }}
            />
            <button
              onClick={() => setShowKey(v => !v)}
              style={{ position: "absolute", right: 10, top: "50%", transform: "translateY(-50%)", background: "none", border: "none", color: "#7a7a8e", cursor: "pointer", fontSize: 13, padding: 0, lineHeight: 1 }}
              tabIndex={-1}
            >
              {showKey ? "🙈" : "👁"}
            </button>
          </div>
          <div style={{ display: "flex", gap: 8, justifyContent: "flex-end" }}>
            {apiKey && (
              <button onClick={() => setShowKeyModal(false)} style={{ padding: "8px 16px", borderRadius: 5, border: "1px solid #1e1e2a", background: "transparent", color: "#7a7a8e", fontSize: 10, fontFamily: "inherit", fontWeight: 700, letterSpacing: "0.08em", textTransform: "uppercase", cursor: "pointer" }}>
                Cancel
              </button>
            )}
            <button onClick={saveKey} disabled={!keyDraft.trim()} style={{ padding: "8px 20px", borderRadius: 5, border: "none", background: keyDraft.trim() ? "#16a34a" : "#111120", color: keyDraft.trim() ? "#fff" : "#5a5a6e", fontSize: 10, fontFamily: "inherit", fontWeight: 700, letterSpacing: "0.08em", textTransform: "uppercase", cursor: keyDraft.trim() ? "pointer" : "not-allowed", transition: "all .15s" }}>
              Save Key
            </button>
          </div>
        </div>
      </div>
    )}
    </>
  );
}
