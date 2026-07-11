"use client";

import { useRouter } from "next/navigation";
import { useEffect, useMemo, useState } from "react";
import { Brain, CheckCircle2, Clock3, FileAudio, LogOut, RefreshCw, Sparkles, Trash2, UploadCloud, XCircle } from "lucide-react";
import { clearTrainingSession, getTrainingToken, getTrainingUser, trainingApiFetch } from "../../lib/api";

export default function UploadTestData() {
  const router = useRouter();
  const [ready, setReady] = useState(false);
  const [user, setUser] = useState(null);
  const [files, setFiles] = useState([]);
  const [notes, setNotes] = useState("");
  const [data, setData] = useState({ recordings: [], examples: [], summary: {} });
  const [error, setError] = useState("");
  const [message, setMessage] = useState("");
  const [loading, setLoading] = useState(false);
  const [refreshing, setRefreshing] = useState(false);

  useEffect(() => {
    const token = getTrainingToken();
    if (!token) {
      router.replace("/uploadTestData/login");
      return;
    }
    setUser(getTrainingUser());
    setReady(true);
    refresh();
  }, [router]);

  const summaryCards = useMemo(() => {
    const summary = data.summary || {};
    return [
      ["Uploaded", Number(summary.uploaded || 0), "Waiting for 10 PM training", Clock3],
      ["Trained", Number(summary.trained || 0), "Examples available to prompts", CheckCircle2],
      ["Failed", Number(summary.failed || 0), "Needs review or re-upload", XCircle],
      ["Raw Audio", Number(summary.rawAudioRetained || 0), "Deleted daily at 11:55 PM", FileAudio]
    ];
  }, [data.summary]);

  async function refresh() {
    setRefreshing(true);
    setError("");
    try {
      setData(await trainingApiFetch("/training/recordings"));
    } catch (err) {
      setError(err.message);
    } finally {
      setRefreshing(false);
    }
  }

  async function uploadRecordings(e) {
    e.preventDefault();
    setError("");
    setMessage("");

    if (!files.length) {
      setError("Choose at least one recording first.");
      return;
    }

    setLoading(true);
    try {
      let uploaded = 0;
      for (const file of files) {
        const body = new FormData();
        body.append("file", file);
        body.append("notes", notes);
        await trainingApiFetch("/training/recordings", { method: "POST", body });
        uploaded++;
      }
      setFiles([]);
      setNotes("");
      setMessage(`${uploaded} recording${uploaded === 1 ? "" : "s"} uploaded. They will be trained at 10:00 PM IST.`);
      await refresh();
    } catch (err) {
      setError(err.message);
    } finally {
      setLoading(false);
    }
  }

  async function runTrainingNow() {
    setError("");
    setMessage("");
    setLoading(true);
    try {
      const result = await trainingApiFetch("/training/run", { method: "POST", body: JSON.stringify({ limit: 10 }) });
      setMessage(`Training complete. Processed ${result.processed}, trained ${result.trained}, failed ${result.failed}.`);
      await refresh();
    } catch (err) {
      setError(err.message);
    } finally {
      setLoading(false);
    }
  }

  async function cleanupNow() {
    setError("");
    setMessage("");
    setLoading(true);
    try {
      const result = await trainingApiFetch("/training/cleanup", { method: "POST" });
      setMessage(`Raw recording cleanup complete. Deleted ${result.deleted} file${result.deleted === 1 ? "" : "s"}.`);
      await refresh();
    } catch (err) {
      setError(err.message);
    } finally {
      setLoading(false);
    }
  }

  function logout() {
    clearTrainingSession();
    router.replace("/uploadTestData/login");
  }

  if (!ready) {
    return <div className="flex min-h-screen items-center justify-center bg-slate-50 text-sm text-slate-500">Loading training portal...</div>;
  }

  return (
    <main className="min-h-screen bg-slate-50">
      <header className="border-b border-slate-200 bg-white/95 px-4 py-3 shadow-sm backdrop-blur">
        <div className="mx-auto flex max-w-7xl flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
          <div className="flex items-center gap-3">
            <div className="brand-mark"><Sparkles size={18} /></div>
            <div>
              <div className="text-xl font-black tracking-tight text-slate-950">Training<span className="text-emerald-600">Portal</span></div>
              <p className="text-xs font-medium text-slate-500">Separate recording workflow</p>
            </div>
          </div>
          <div className="flex items-center gap-3">
            <div className="hidden text-right sm:block">
              <p className="text-sm font-semibold text-slate-950">{user?.name || "Training Portal"}</p>
              <p className="text-xs text-slate-500">{user?.email}</p>
            </div>
            <button onClick={logout} className="btn-secondary"><LogOut size={16} /> Logout</button>
          </div>
        </div>
      </header>

      <div className="mx-auto max-w-7xl p-4 sm:p-6 lg:p-8">
      <div className="rounded-lg border border-slate-200 bg-white p-5 shadow-sm">
        <div className="flex flex-col gap-4 sm:flex-row sm:items-end sm:justify-between">
          <div>
            <div className="inline-flex items-center gap-2 rounded-full bg-emerald-50 px-3 py-1 text-xs font-bold text-emerald-700">
              <Brain size={14} /> Conversation training data
            </div>
            <h1 className="mt-3 text-3xl font-black text-slate-950 sm:text-4xl">Upload Test Data</h1>
            <p className="mt-2 max-w-3xl text-sm leading-6 text-slate-500">
              Upload real call recordings. The backend transcribes them, extracts reusable intent and reply patterns at 10:00 PM IST, and removes raw audio at 11:55 PM IST.
            </p>
          </div>
          <button onClick={refresh} className="btn-secondary" disabled={refreshing}>
            <RefreshCw size={16} className={refreshing ? "animate-spin" : ""} /> Refresh
          </button>
        </div>
      </div>

      {error && <div className="mt-6 rounded-lg border border-red-200 bg-red-50 px-4 py-3 text-sm text-red-700">{error}</div>}
      {message && <div className="mt-6 rounded-lg border border-emerald-200 bg-emerald-50 px-4 py-3 text-sm text-emerald-700">{message}</div>}

      <section className="mt-6 grid grid-cols-1 gap-4 sm:grid-cols-2 xl:grid-cols-4">
        {summaryCards.map(([label, value, hint, Icon]) => (
          <div className="stat-card" key={label}>
            <div className="flex items-center justify-between gap-3">
              <p className="text-sm font-semibold text-slate-500">{label}</p>
              <Icon size={18} className="text-sky-600" />
            </div>
            <p className="mt-3 text-4xl font-black text-slate-950">{value}</p>
            <p className="mt-2 text-xs text-slate-500">{hint}</p>
          </div>
        ))}
      </section>

      <section className="mt-8 grid grid-cols-1 gap-6 xl:grid-cols-[0.95fr_1.05fr]">
        <form onSubmit={uploadRecordings} className="card p-6">
          <h2 className="flex items-center gap-2 text-lg font-black text-slate-950"><UploadCloud size={18} className="text-sky-600" /> Upload Recordings</h2>
          <p className="mt-2 text-sm leading-6 text-slate-500">Accepted formats include AAC, MP3, M4A, WAV and OGG. Upload before 10:00 PM IST for same-day training.</p>

          <label className="mt-6 block text-sm font-semibold text-slate-600">Recording files</label>
          <input
            className="input mt-3"
            type="file"
            multiple
            accept="audio/*,.aac,.m4a,.mp3,.wav,.ogg"
            onChange={e => setFiles(Array.from(e.target.files || []))}
          />
          {!!files.length && (
            <div className="mt-3 rounded-lg border border-slate-200 bg-slate-50 p-3 text-xs text-slate-600">
              {files.map(file => <div key={`${file.name}-${file.size}`}>{file.name} - {formatBytes(file.size)}</div>)}
            </div>
          )}

          <label className="mt-5 block text-sm font-semibold text-slate-600">Notes</label>
          <textarea
            className="input mt-3 min-h-28"
            value={notes}
            onChange={e => setNotes(e.target.value)}
            placeholder="Example: Good TezCredit agent call, customer asked about amount and website login."
          />

          <button className="btn mt-5 w-full sm:w-auto" disabled={loading}>{loading ? "Working..." : "Upload Test Data"}</button>
        </form>

        <div className="card p-6">
          <h2 className="text-lg font-black text-slate-950">Training Controls</h2>
          <p className="mt-2 text-sm leading-6 text-slate-500">The scheduler runs automatically. Use manual actions only when you want to validate a recording immediately.</p>
          <div className="mt-5 flex flex-col gap-3 sm:flex-row">
            <button onClick={runTrainingNow} className="btn" disabled={loading}><Brain size={16} /> Run Training Now</button>
            <button onClick={cleanupNow} className="btn-secondary" disabled={loading}><Trash2 size={16} /> Delete Raw Audio Now</button>
          </div>
          <div className="mt-6 rounded-lg border border-amber-200 bg-amber-50 p-4 text-sm leading-6 text-amber-800">
            Raw audio is temporary. Transcripts and extracted handling examples are retained so the voicebot can use the learning without keeping recordings.
          </div>
        </div>
      </section>

      <section className="card mt-8 overflow-hidden">
        <div className="border-b border-slate-200 p-5">
          <h2 className="text-lg font-black text-slate-950">Uploaded Recordings</h2>
        </div>
        <div className="overflow-x-auto">
          <table className="w-full min-w-[900px] text-sm">
            <thead className="bg-slate-50 text-left text-slate-500">
              <tr>
                <th className="p-4">File</th>
                <th>Status</th>
                <th>Raw Audio</th>
                <th>Uploaded</th>
                <th>Transcript Preview</th>
              </tr>
            </thead>
            <tbody>
              {(data.recordings || []).map(recording => (
                <tr key={recording.id} className="border-t border-slate-200 align-top">
                  <td className="p-4">
                    <div className="font-semibold text-slate-950">{recording.filename}</div>
                    <div className="mt-1 text-xs text-slate-500">{formatBytes(recording.size_bytes)} - {recording.mime_type || "audio"}</div>
                    {recording.error && <div className="mt-2 max-w-sm text-xs text-red-600">{recording.error}</div>}
                  </td>
                  <td><span className="status-pill">{formatStatus(recording.status)}</span></td>
                  <td>{recording.has_audio ? "Retained" : "Deleted"}</td>
                  <td>{formatDate(recording.created_at)}</td>
                  <td className="max-w-xl pr-4 text-slate-600">{recording.transcript ? `${recording.transcript.slice(0, 220)}${recording.transcript.length > 220 ? "..." : ""}` : "-"}</td>
                </tr>
              ))}
              {!data.recordings?.length && (
                <tr><td className="p-4 text-slate-500" colSpan="5">No recordings uploaded yet.</td></tr>
              )}
            </tbody>
          </table>
        </div>
      </section>

      <section className="card mt-8 overflow-hidden">
        <div className="border-b border-slate-200 p-5">
          <h2 className="text-lg font-black text-slate-950">Learned Examples</h2>
        </div>
        <div className="divide-y divide-slate-200">
          {(data.examples || []).map(example => (
            <div key={example.id} className="grid gap-3 p-5 lg:grid-cols-[12rem_1fr]">
              <div>
                <span className="status-pill">{formatStatus(example.intent_key)}</span>
                <p className="mt-2 text-xs text-slate-500">{formatDate(example.updated_at)}</p>
              </div>
              <div>
                <p className="text-sm font-semibold text-slate-950">Customer phrase: {example.user_phrase}</p>
                <p className="mt-2 text-sm leading-6 text-slate-600">{example.recommended_reply}</p>
              </div>
            </div>
          ))}
          {!data.examples?.length && <div className="p-5 text-sm text-slate-500">No learned examples yet. Upload recordings, then run training or wait for 10:00 PM IST.</div>}
        </div>
      </section>
      </div>
    </main>
  );
}

function formatBytes(value) {
  const bytes = Number(value || 0);
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}

function formatDate(value) {
  if (!value) return "-";
  return new Intl.DateTimeFormat("en-IN", {
    dateStyle: "medium",
    timeStyle: "short",
    timeZone: "Asia/Kolkata"
  }).format(new Date(value));
}

function formatStatus(value) {
  return String(value || "")
    .replace(/_/g, " ")
    .replace(/\b\w/g, letter => letter.toUpperCase());
}
