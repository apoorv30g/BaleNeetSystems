"use client";

import Link from "next/link";
import { useParams, useRouter } from "next/navigation";
import { useEffect, useMemo, useState } from "react";
import { Activity, Download, Filter, PhoneCall, RefreshCcw, TimerReset, Trash2 } from "lucide-react";
import Shell from "../../../components/Shell";
import { API_BASE_URL, apiFetch, getToken } from "../../../lib/api";

const outcomes = ["IN_PROGRESS", "INTERESTED", "PROMISE_TO_PAY", "PAID", "CALLBACK", "WRONG_NUMBER", "VOICEMAIL", "CALL_SCREENING", "DISPUTE", "NOT_INTERESTED", "OPTED_OUT", "UNCLEAR"];

export default function CampaignDetail() {
  const { campaignId } = useParams();
  const router = useRouter();
  const [campaign, setCampaign] = useState(null);
  const [playbooks, setPlaybooks] = useState({});
  const [queueStatus, setQueueStatus] = useState(null);
  const [leads, setLeads] = useState([]);
  const [calls, setCalls] = useState([]);
  const [transcripts, setTranscripts] = useState([]);
  const [selected, setSelected] = useState([]);
  const [filters, setFilters] = useState({ q: "", status: "all", playbook: "all" });
  const [file, setFile] = useState(null);
  const [uploadResult, setUploadResult] = useState(null);
  const [message, setMessage] = useState("");
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(false);
  const [editOpen, setEditOpen] = useState(false);
  const [form, setForm] = useState({});

  async function load() {
    const [campaignData, leadData, callData, transcriptData, playbookData, queueData] = await Promise.all([
      apiFetch(`/campaigns/${campaignId}`),
      apiFetch(`/campaigns/${campaignId}/leads`),
      apiFetch(`/campaigns/${campaignId}/calls`),
      apiFetch(`/campaigns/${campaignId}/transcripts`),
      apiFetch("/playbooks"),
      apiFetch(`/campaigns/${campaignId}/queue-status`).catch(() => null)
    ]);

    setCampaign(campaignData);
    setForm({
      name: campaignData.name || "",
      description: campaignData.description || "",
      status: campaignData.status || "draft",
      campaignType: campaignData.campaign_type || "RETARGETING",
      playbookType: campaignData.playbook_type || "UNAPPROVED_USERS",
      dailyLimit: campaignData.daily_limit || 200,
      maxAttempts: campaignData.max_attempts || 3,
      language: campaignData.language || "Hinglish"
    });
    setLeads(leadData);
    setCalls(callData);
    setTranscripts(transcriptData);
    setPlaybooks(playbookData);
    setQueueStatus(queueData);
    setSelected(current => current.filter(id => leadData.some(lead => lead.id === id)));
  }

  useEffect(() => {
    load().catch(err => setError(err.message));
  }, [campaignId]);

  const filteredLeads = useMemo(() => {
    const q = filters.q.trim().toLowerCase();
    return leads.filter(lead => {
      const matchesText = !q || [lead.name, lead.phone, lead.playbook_type, lead.drop_stage, lead.source_status].some(value => String(value || "").toLowerCase().includes(q));
      const matchesStatus = filters.status === "all" || lead.status === filters.status;
      const matchesPlaybook = filters.playbook === "all" || lead.playbook_type === filters.playbook;
      return matchesText && matchesStatus && matchesPlaybook;
    });
  }, [filters, leads]);

  const allVisibleSelected = filteredLeads.length > 0 && filteredLeads.every(lead => selected.includes(lead.id));
  const latestCallByLead = useMemo(() => {
    const map = new Map();
    for (const call of calls) {
      if (call.lead_id && !map.has(call.lead_id)) map.set(call.lead_id, call);
    }
    return map;
  }, [calls]);
  const callStats = useMemo(() => {
    const outcomeCounts = calls.reduce((acc, call) => {
      const key = call.outcome || "IN_PROGRESS";
      acc[key] = (acc[key] || 0) + 1;
      return acc;
    }, {});
    const billableMinutes = calls.reduce((sum, call) => sum + Math.ceil(Number(call.duration_seconds || 0) / 60), 0);
    const nonHuman = (outcomeCounts.VOICEMAIL || 0) + (outcomeCounts.CALL_SCREENING || 0);
    const positive = (outcomeCounts.INTERESTED || 0) + (outcomeCounts.PROMISE_TO_PAY || 0) + (outcomeCounts.PAID || 0);
    return {
      outcomeCounts,
      billableMinutes,
      nonHuman,
      positive,
      completed: calls.filter(call => call.status === "completed").length
    };
  }, [calls]);
  const stats = [
    ["Leads", campaign?.lead_count || 0],
    ["Pending", campaign?.pending_count || 0],
    ["Queued", campaign?.queued_count || 0],
    ["Called", campaign?.called_count || 0],
    ["Positive", callStats.positive || 0],
    ["Voicemail/Screening", callStats.nonHuman || 0]
  ];

  function setNotice({ ok, text }) {
    setError(ok ? "" : text);
    setMessage(ok ? text : "");
  }

  async function runAction(action, success) {
    setLoading(true);
    setError("");
    setMessage("");
    try {
      const result = await action();
      setNotice({ ok: true, text: success(result) });
      await load();
    } catch (err) {
      setError(err.message);
    } finally {
      setLoading(false);
    }
  }

  async function upload(e) {
    e.preventDefault();
    if (!file) return setError("Choose a CSV or Excel file first.");
    const body = new FormData();
    body.append("file", file);
    setLoading(true);
    setError("");
    setMessage("");
    setUploadResult(null);
    try {
      const result = await apiFetch(`/campaigns/${campaignId}/upload`, { method: "POST", body });
      setUploadResult(result);
      setNotice({
        ok: true,
        text: `Inserted ${result.inserted}, skipped ${result.skipped}. ${result.errors?.length ? "Review skipped rows below." : ""}`
      });
      await load();
    } catch (err) {
      setError(err.message);
    } finally {
      setLoading(false);
    }
  }

  async function saveCampaign(e) {
    e.preventDefault();
    await runAction(
      () => apiFetch(`/campaigns/${campaignId}`, { method: "PUT", body: JSON.stringify(form) }),
      () => "Campaign updated."
    );
    setEditOpen(false);
  }

  async function deleteCampaign() {
    if (!confirm("Delete this campaign and its leads?")) return;
    await apiFetch(`/campaigns/${campaignId}`, { method: "DELETE" });
    router.replace("/campaigns");
  }

  async function bulkQueue(ids = selected) {
    await runAction(
      () => apiFetch(`/campaigns/${campaignId}/leads/bulk-queue`, { method: "POST", body: JSON.stringify({ leadIds: ids, force: true }) }),
      result => result.queued
        ? `Queued ${result.queued} selected calls. Blocked ${result.blocked} DNC leads.`
        : `No selected calls were queued. Blocked ${result.blocked} DNC leads.`
    );
    setSelected([]);
  }

  async function queueLead(lead) {
    await runAction(
      () => apiFetch(`/campaigns/${campaignId}/leads/${lead.id}/queue-call`, { method: "POST" }),
      result => result.queued
        ? `Queued call for ${lead.name || lead.phone}.`
        : `Could not queue ${lead.name || lead.phone}. Blocked ${result.blocked} DNC leads.`
    );
  }

  async function bulkDelete(ids = selected) {
    if (!ids.length || !confirm(`Remove ${ids.length} selected leads from this campaign?`)) return;
    await runAction(
      () => apiFetch(`/campaigns/${campaignId}/leads/bulk-delete`, { method: "POST", body: JSON.stringify({ leadIds: ids }) }),
      result => `Removed ${result.deleted} leads and ${result.removedJobs} queued jobs.`
    );
    setSelected([]);
  }

  async function exportCsv(kind) {
    setError("");
    try {
      const res = await fetch(`${API_BASE_URL}/campaigns/${campaignId}/export/${kind}`, {
        headers: { Authorization: `Bearer ${getToken()}` }
      });
      if (!res.ok) throw new Error(`Could not export ${kind}`);
      const blob = await res.blob();
      const url = URL.createObjectURL(blob);
      const link = document.createElement("a");
      link.href = url;
      link.download = `${kind}.csv`;
      link.click();
      URL.revokeObjectURL(url);
    } catch (err) {
      setError(err.message);
    }
  }

  function toggleVisible() {
    if (allVisibleSelected) {
      setSelected(current => current.filter(id => !filteredLeads.some(lead => lead.id === id)));
      return;
    }
    setSelected(current => Array.from(new Set([...current, ...filteredLeads.map(lead => lead.id)])));
  }

  function cleanProviderError(error) {
    if (!error) return "";
    return String(error)
      .replace(/<[^>]+>/g, " ")
      .replace(/\s+/g, " ")
      .replace(/^Exotel failed:\s*/i, "")
      .trim();
  }

  return (
    <Shell>
      <div className="flex flex-col gap-4 rounded-lg border border-slate-200 bg-white p-5 shadow-sm xl:flex-row xl:items-start xl:justify-between">
        <div>
          <Link href="/campaigns" className="text-sm font-semibold text-sky-700 hover:text-sky-900">Campaigns</Link>
          <h1 className="mt-2 text-3xl font-black text-slate-950 sm:text-4xl">{campaign?.name || "Campaign"}</h1>
          <p className="mt-2 max-w-3xl text-sm text-slate-500 sm:text-base">{campaign?.description || "Upload leads, queue calls and inspect outcomes."}</p>
        </div>
        <div className="flex flex-wrap gap-2">
          <button onClick={() => setEditOpen(!editOpen)} className="btn-secondary">Edit</button>
          <button onClick={() => runAction(() => apiFetch(`/campaigns/${campaignId}/retry-failed`, { method: "POST", body: JSON.stringify({ resetAttempts: true }) }), result => `Retried ${result.queued} failed leads.`)} className="btn-secondary" disabled={loading}><RefreshCcw size={16} /> Retry Failed</button>
          <button onClick={() => runAction(() => apiFetch(`/campaigns/${campaignId}/clear-queue`, { method: "POST" }), result => `Removed ${result.removedJobs} queued jobs. Reset ${result.resetLeads} leads.`)} className="btn-secondary" disabled={loading}>Clear Queue</button>
          <button onClick={() => runAction(() => apiFetch(`/campaigns/${campaignId}/queue-calls`, { method: "POST" }), result => `Queued ${result.queued} calls. Blocked ${result.blocked} DNC leads.`)} className="btn" disabled={loading}><PhoneCall size={16} /> Queue Calls</button>
        </div>
      </div>

      {error && <div className="mt-6 rounded-lg border border-red-200 bg-red-50 px-4 py-3 text-sm text-red-700">{error}</div>}
      {message && <div className="mt-6 rounded-lg border border-emerald-200 bg-emerald-50 px-4 py-3 text-sm text-emerald-700">{message}</div>}

      {editOpen && (
        <form onSubmit={saveCampaign} className="card mt-8 grid grid-cols-1 gap-4 p-5 md:grid-cols-2 md:p-6">
          <input className="input" value={form.name || ""} onChange={e => setForm({ ...form, name: e.target.value })} placeholder="Campaign name, e.g. June fresh leads" />
          <select className="input" value={form.status || "draft"} onChange={e => setForm({ ...form, status: e.target.value })} aria-label="Campaign status" title="Campaign status">
            {["draft", "active", "paused", "completed"].map(status => <option key={status} value={status}>{status}</option>)}
          </select>
          <input className="input" value={form.description || ""} onChange={e => setForm({ ...form, description: e.target.value })} placeholder="Description, e.g. Follow up on approved offers" />
          <select className="input" value={form.campaignType || "RETARGETING"} onChange={e => setForm({ ...form, campaignType: e.target.value })} aria-label="Campaign type" title="Campaign type">
            <option value="RETARGETING">Retargeting</option>
            <option value="COLLECTION">Collection</option>
            <option value="TARGETING">Targeting</option>
          </select>
          <select className="input" value={form.playbookType || ""} onChange={e => setForm({ ...form, playbookType: e.target.value })} aria-label="Playbook" title="Playbook">
            {Object.entries(playbooks).map(([key, playbook]) => <option key={key} value={key}>{playbook.title}</option>)}
          </select>
          <input className="input" value={form.language || ""} onChange={e => setForm({ ...form, language: e.target.value })} placeholder="Language, e.g. Hinglish, Hindi, English" />
          <input className="input" type="number" min="1" placeholder="Daily call limit, e.g. 200" aria-label="Daily call limit" title="Daily call limit" value={form.dailyLimit || 200} onChange={e => setForm({ ...form, dailyLimit: Number(e.target.value) })} />
          <input className="input" type="number" min="1" placeholder="Max attempts per lead, e.g. 3" aria-label="Max attempts per lead" title="Max attempts per lead" value={form.maxAttempts || 3} onChange={e => setForm({ ...form, maxAttempts: Number(e.target.value) })} />
          <button className="btn">Save</button>
          <button type="button" onClick={deleteCampaign} className="btn-secondary">Delete Campaign</button>
        </form>
      )}

      <section className="mt-8 grid grid-cols-2 gap-3 md:grid-cols-3 xl:grid-cols-6">
        {stats.map(([label, value]) => (
          <div className="stat-card p-4" key={label}>
            <p className="text-xs font-semibold text-slate-500">{label}</p>
            <p className="mt-2 text-2xl font-black text-slate-950">{value}</p>
          </div>
        ))}
        <div className="stat-card col-span-2 p-4 md:col-span-3 xl:col-span-1">
          <p className="text-xs font-semibold text-slate-500">Queue</p>
          <p className="mt-2 text-2xl font-black text-slate-950">{queueStatus?.campaignQueued || 0}</p>
          <p className="mt-1 text-xs text-slate-500">{queueStatus?.workerHint || "Queue status unavailable"}</p>
        </div>
      </section>

      <section className="mt-6 grid grid-cols-1 gap-4 xl:grid-cols-[1.2fr_1fr]">
        <div className="card p-5">
          <div className="flex items-center gap-2">
            <Activity className="text-sky-700" size={18} />
            <h2 className="text-lg font-black text-slate-950">Channel Queue</h2>
          </div>
          <div className="mt-4 grid grid-cols-2 gap-3 md:grid-cols-4">
            <MiniMetric label="Channels" value={queueStatus?.channels?.configured || 0} />
            <MiniMetric label="Active" value={queueStatus?.channels?.active || 0} />
            <MiniMetric label="Available" value={queueStatus?.channels?.available || 0} />
            <MiniMetric label="Waiting" value={queueStatus?.channels?.waiting || 0} />
          </div>
          {!!queueStatus?.activeJobs?.length && (
            <div className="mt-4 space-y-2">
              {queueStatus.activeJobs.map(job => (
                <div key={job.id} className="flex items-center justify-between rounded-lg bg-slate-50 px-3 py-2 text-xs text-slate-600">
                  <span className="font-semibold">{job.leadId}</span>
                  <span>{job.ageSeconds}s active</span>
                </div>
              ))}
            </div>
          )}
        </div>

        <div className="card p-5">
          <div className="flex items-center gap-2">
            <TimerReset className="text-emerald-700" size={18} />
            <h2 className="text-lg font-black text-slate-950">Call Quality</h2>
          </div>
          <div className="mt-4 grid grid-cols-2 gap-3">
            <MiniMetric label="Completed" value={callStats.completed} />
            <MiniMetric label="Billable Min" value={callStats.billableMinutes} />
            <MiniMetric label="Interested" value={callStats.outcomeCounts.INTERESTED || 0} />
            <MiniMetric label="Callback" value={callStats.outcomeCounts.CALLBACK || 0} />
          </div>
        </div>
      </section>

      <section className="mt-8 grid grid-cols-1 gap-4 xl:grid-cols-[360px_1fr]">
        <form onSubmit={upload} className="card p-5">
          <h2 className="text-lg font-black text-slate-950">Upload Leads</h2>
          <p className="mt-2 text-sm text-slate-500">Upload CSV or TezCredit/CredNorth Excel. Headers like Mobile Number, Selfie, Aadhaar, Penny Drop and E-sign are auto-mapped.</p>
          <input className="input mt-5" type="file" accept=".csv,text/csv,.xlsx,application/vnd.openxmlformats-officedocument.spreadsheetml.sheet" onChange={e => setFile(e.target.files?.[0] || null)} />
          <button className="btn mt-4 w-full" disabled={loading}>{loading ? "Working..." : "Upload Leads"}</button>
          {uploadResult && (
            <div className="mt-5 space-y-4 text-sm">
              <UploadBreakdown title="Imported stages" data={uploadResult.stageCounts} />
              <UploadBreakdown title="Skipped rows" data={uploadResult.skippedReasons} />
              {!!uploadResult.errors?.length && (
                <div className="rounded-lg bg-slate-50 p-3">
                  <p className="font-bold text-slate-800">First skipped rows</p>
                  <div className="mt-2 space-y-1 text-xs text-slate-600">
                    {uploadResult.errors.slice(0, 5).map((item, index) => (
                      <p key={`${item.row}-${index}`}>Row {item.row}: {item.error}{item.stage ? ` (${item.stage})` : ""}</p>
                    ))}
                  </div>
                </div>
              )}
            </div>
          )}
        </form>

        <div className="card p-5">
          <div className="grid grid-cols-1 gap-3 lg:grid-cols-[1fr_160px_220px_auto]">
            <input className="input" placeholder="Search by name, phone, status or playbook" value={filters.q} onChange={e => setFilters({ ...filters, q: e.target.value })} />
            <select className="input" value={filters.status} onChange={e => setFilters({ ...filters, status: e.target.value })} aria-label="Lead status filter" title="Lead status filter">
              {["all", "pending", "queued", "called", "completed", "failed", "max_attempts"].map(status => <option key={status} value={status}>{status}</option>)}
            </select>
            <select className="input" value={filters.playbook} onChange={e => setFilters({ ...filters, playbook: e.target.value })} aria-label="Playbook filter" title="Playbook filter">
              <option value="all">All playbooks</option>
              {Object.entries(playbooks).map(([key, playbook]) => <option key={key} value={key}>{playbook.title}</option>)}
            </select>
            <button className="btn-secondary justify-center" type="button"><Filter size={16} /> {filteredLeads.length}</button>
          </div>
          <div className="mt-4 flex flex-wrap gap-2">
            <button className="btn-secondary" type="button" onClick={() => selected.length && bulkQueue()} disabled={!selected.length || loading}><PhoneCall size={16} /> Call Selected</button>
            <button className="btn-secondary" type="button" onClick={() => bulkDelete()} disabled={!selected.length || loading}><Trash2 size={16} /> Remove Selected</button>
            {["leads", "calls", "transcripts"].map(kind => (
              <button key={kind} className="btn-secondary" type="button" onClick={() => exportCsv(kind)}><Download size={16} /> {kind}</button>
            ))}
          </div>
        </div>
      </section>

      <section className="card mt-8 overflow-x-auto">
        <table className="w-full min-w-[1180px] text-sm">
          <thead className="bg-slate-50 text-left text-slate-500">
            <tr>
              <th className="p-4"><input type="checkbox" checked={allVisibleSelected} onChange={toggleVisible} /></th>
              <th>Name</th><th>Phone</th><th>Journey Stage</th><th>Playbook</th><th>Status</th><th>Last Outcome</th><th>Attempts</th><th></th>
            </tr>
          </thead>
          <tbody>
            {filteredLeads.map(lead => (
              <tr key={lead.id} className="border-t border-slate-200">
                <td className="p-4"><input type="checkbox" checked={selected.includes(lead.id)} onChange={() => setSelected(current => current.includes(lead.id) ? current.filter(id => id !== lead.id) : [...current, lead.id])} /></td>
                <td className="font-semibold text-slate-950">{lead.name || "Unknown"}</td>
                <td>{lead.phone}</td>
                <td><span className="status-pill">{formatStage(lead.drop_stage)}</span></td>
                <td>{playbooks[lead.playbook_type]?.title || lead.playbook_type}</td>
                <td><span className="status-pill">{lead.status}</span></td>
                <td><span className="status-pill">{latestCallByLead.get(lead.id)?.outcome || "-"}</span></td>
                <td>{lead.attempt_count}</td>
                <td className="pr-4 text-right">
                  <div className="flex flex-wrap justify-end gap-2">
                    <button onClick={() => queueLead(lead)} className="btn" disabled={loading}><PhoneCall size={16} /> Call Now</button>
                    <button onClick={() => runAction(() => apiFetch(`/campaigns/${campaignId}/leads/${lead.id}/send-link`, { method: "POST", body: JSON.stringify({ channel: "sms" }) }), event => `SMS link ${event.status}.`)} className="btn-secondary">SMS</button>
                    <button onClick={() => bulkDelete([lead.id])} className="btn-secondary">Remove</button>
                  </div>
                </td>
              </tr>
            ))}
            {!filteredLeads.length && <tr><td className="p-4 text-slate-500" colSpan="9">No leads match the current view.</td></tr>}
          </tbody>
        </table>
      </section>

      <section className="mt-8 grid grid-cols-1 gap-4 xl:grid-cols-2">
        <div className="card overflow-x-auto">
          <div className="border-b border-slate-200 p-5"><h2 className="text-lg font-black text-slate-950">Calls</h2></div>
          <table className="w-full min-w-[980px] text-sm">
            <thead className="bg-slate-50 text-left text-slate-500">
              <tr><th className="p-4">Lead</th><th>Status</th><th>Outcome</th><th>Confidence</th><th>Next Action</th><th>Summary</th><th>Failure</th><th>Duration</th></tr>
            </thead>
            <tbody>
              {calls.map(call => (
                <tr key={call.id} className="border-t border-slate-200">
                  <td className="p-4">{call.lead_name || call.phone || "Unknown"}</td>
                  <td><span className="status-pill">{call.status}</span></td>
                  <td><select className="input max-w-44 py-2" value={call.outcome || "IN_PROGRESS"} onChange={e => runAction(() => apiFetch(`/campaigns/${campaignId}/calls/${call.id}/outcome`, { method: "PATCH", body: JSON.stringify({ outcome: e.target.value }) }), () => "Outcome updated.")}>{outcomes.map(outcome => <option key={outcome} value={outcome}>{outcome}</option>)}</select></td>
                  <td>{Math.round(Number(call.confidence || 0) * 100)}%</td>
                  <td className="max-w-64 pr-4 text-slate-600">{call.next_action || "-"}</td>
                  <td className="max-w-80 pr-4 text-slate-500">{call.summary || "-"}</td>
                  <td className="max-w-72 pr-4 text-red-600" title={cleanProviderError(call.error)}>{cleanProviderError(call.error) || "-"}</td>
                  <td>{call.duration_seconds || 0}s</td>
                </tr>
              ))}
              {!calls.length && <tr><td className="p-4 text-slate-500" colSpan="8">No calls yet.</td></tr>}
            </tbody>
          </table>
        </div>

        <div className="card overflow-hidden">
          <div className="border-b border-slate-200 p-5"><h2 className="text-lg font-black text-slate-950">Transcripts</h2></div>
          <div className="max-h-[420px] overflow-auto">
            {transcripts.map(item => (
              <div key={item.id} className="border-b border-slate-200 p-4 text-sm">
                <div className="flex justify-between gap-4">
                  <span className="font-semibold text-slate-950">{item.lead_name || item.phone || "Unknown"}</span>
                  <span className="text-slate-500">{item.speaker}</span>
                </div>
                <p className="mt-2 text-slate-600">{item.text}</p>
              </div>
            ))}
            {!transcripts.length && <div className="p-4 text-sm text-slate-500">No transcripts yet.</div>}
          </div>
        </div>
      </section>
    </Shell>
  );
}

function MiniMetric({ label, value }) {
  return (
    <div className="rounded-lg bg-slate-50 p-3">
      <p className="text-xs font-semibold text-slate-500">{label}</p>
      <p className="mt-1 text-xl font-black text-slate-950">{Number(value || 0).toLocaleString("en-IN")}</p>
    </div>
  );
}

function UploadBreakdown({ title, data }) {
  const entries = Object.entries(data || {});
  if (!entries.length) return null;
  return (
    <div className="rounded-lg bg-slate-50 p-3">
      <p className="font-bold text-slate-800">{title}</p>
      <div className="mt-2 space-y-1 text-xs text-slate-600">
        {entries.map(([key, value]) => (
          <div key={key} className="flex justify-between gap-3">
            <span>{formatStage(key)}</span>
            <span className="font-bold text-slate-900">{Number(value || 0).toLocaleString("en-IN")}</span>
          </div>
        ))}
      </div>
    </div>
  );
}

function formatStage(value) {
  return String(value || "-")
    .toLowerCase()
    .replace(/_/g, " ")
    .replace(/\b\w/g, letter => letter.toUpperCase());
}
