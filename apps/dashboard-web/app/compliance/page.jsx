"use client";

import { useEffect, useState } from "react";
import Shell from "../../components/Shell";
import { apiFetch } from "../../lib/api";

export default function Compliance() {
  const [settings, setSettings] = useState(null);
  const [dnc, setDnc] = useState([]);
  const [logs, setLogs] = useState([]);
  const [phone, setPhone] = useState("");
  const [reason, setReason] = useState("manual");
  const [settingsForm, setSettingsForm] = useState(null);
  const [error, setError] = useState("");
  const [message, setMessage] = useState("");

  const [auditSummary, setAuditSummary] = useState(null);
  const [flagged, setFlagged] = useState([]);
  const [promises, setPromises] = useState([]);

  async function load() {
    const [settingsData, dncData, logsData] = await Promise.all([
      apiFetch("/compliance/settings"),
      apiFetch("/compliance/dnc"),
      apiFetch("/compliance/logs")
    ]);
    setSettings(settingsData);
    setSettingsForm(settingsData);
    setDnc(dncData);
    setLogs(logsData);
    apiFetch("/compliance/audit/summary").then(setAuditSummary).catch(() => {});
    apiFetch("/compliance/audit/flagged").then(setFlagged).catch(() => {});
    apiFetch("/compliance/promises").then(setPromises).catch(() => {});
  }

  async function toggleShareLearnings(enabled) {
    setError("");
    setMessage("");
    try {
      await apiFetch("/compliance/share-learnings", { method: "PUT", body: JSON.stringify({ enabled }) });
      setMessage(enabled ? "Joined the shared learning network." : "Left the shared learning network.");
      await load();
    } catch (err) {
      setError(err.message);
    }
  }

  async function saveSettings(e) {
    e.preventDefault();
    setError("");
    setMessage("");
    try {
      await apiFetch("/compliance/settings", { method: "PUT", body: JSON.stringify(settingsForm) });
      setMessage("Compliance settings saved.");
      await load();
    } catch (err) {
      setError(err.message);
    }
  }

  useEffect(() => {
    load().catch(err => setError(err.message));
  }, []);

  async function addDnc(e) {
    e.preventDefault();
    setError("");
    setMessage("");
    try {
      await apiFetch("/compliance/dnc", { method: "POST", body: JSON.stringify({ phone, reason }) });
      setPhone("");
      setMessage("DNC entry saved.");
      await load();
    } catch (err) {
      setError(err.message);
    }
  }

  async function removeDnc(phoneNumber) {
    setError("");
    setMessage("");
    try {
      await apiFetch(`/compliance/dnc/${phoneNumber}`, { method: "DELETE" });
      setMessage("DNC entry removed.");
      await load();
    } catch (err) {
      setError(err.message);
    }
  }

  return (
    <Shell>
      <div className="rounded-lg border border-slate-200 bg-white p-5 shadow-sm">
        <h1 className="text-3xl font-black text-slate-950 sm:text-4xl">Compliance</h1>
        <p className="mt-2 text-sm text-slate-500">Operational guardrails, DNC controls and compliance events.</p>
      </div>

      {error && <div className="mt-6 rounded-lg border border-red-200 bg-red-50 px-4 py-3 text-sm text-red-700">{error}</div>}
      {message && <div className="mt-6 rounded-lg border border-emerald-200 bg-emerald-50 px-4 py-3 text-sm text-emerald-700">{message}</div>}

      <section className="mt-8 grid grid-cols-1 gap-4 sm:grid-cols-2 xl:grid-cols-4">
        <div className="stat-card"><p className="text-sm font-semibold text-slate-500">Call Window</p><p className="mt-3 text-3xl font-black text-slate-950">{settings?.callWindowStart || 9}:00-{settings?.callWindowEnd || 20}:00</p></div>
        <div className="stat-card"><p className="text-sm font-semibold text-slate-500">Max Attempts</p><p className="mt-3 text-3xl font-black text-slate-950">{settings?.maxCallAttempts || 3}</p></div>
        <div className="stat-card"><p className="text-sm font-semibold text-slate-500">Retry Delay</p><p className="mt-3 text-3xl font-black text-slate-950">{settings?.retryDelayMinutes || 360}m</p></div>
        <div className="stat-card"><p className="text-sm font-semibold text-slate-500">DNC Entries</p><p className="mt-3 text-3xl font-black text-slate-950">{dnc.length}</p></div>
      </section>

      <section className="mt-8 card p-6">
        <div className="flex items-center justify-between gap-4">
          <div>
            <div className="text-xs font-bold uppercase tracking-widest text-sky-600">Compliance autopilot</div>
            <h2 className="mt-2 text-lg font-black text-slate-950">Every call audited, not sampled</h2>
            <p className="mt-1 text-sm text-slate-500">Automated checks: disclosure spoken, no OTP requests, no guaranteed-approval promises, no threats, opt-out honored, calling window respected.</p>
          </div>
          {auditSummary && (
            <div className="text-right">
              <p className="text-4xl font-black text-slate-950">{Number(auditSummary.avg_score || 0).toFixed(0)}</p>
              <p className="text-xs font-semibold text-slate-500">avg score (7d, {auditSummary.audited || 0} calls)</p>
            </div>
          )}
        </div>
        {auditSummary && (
          <div className="mt-4 grid grid-cols-3 gap-3">
            <div className="rounded-lg bg-emerald-50 p-3 text-center"><p className="text-2xl font-black text-emerald-700">{auditSummary.passed || 0}</p><p className="text-xs font-semibold text-slate-500">Passed</p></div>
            <div className="rounded-lg bg-amber-50 p-3 text-center"><p className="text-2xl font-black text-amber-700">{auditSummary.warned || 0}</p><p className="text-xs font-semibold text-slate-500">Warnings</p></div>
            <div className="rounded-lg bg-red-50 p-3 text-center"><p className="text-2xl font-black text-red-700">{auditSummary.failed || 0}</p><p className="text-xs font-semibold text-slate-500">Failed</p></div>
          </div>
        )}
        {flagged.length > 0 && (
          <div className="mt-5">
            <h3 className="text-sm font-bold text-slate-700">Flagged calls</h3>
            <div className="mt-2 max-h-72 space-y-2 overflow-auto">
              {flagged.map(call => (
                <div key={call.call_id} className="rounded-lg border border-red-200 bg-red-50 p-3 text-sm">
                  <div className="flex items-center justify-between">
                    <span className="font-semibold text-slate-700">{call.lead_name || call.phone || "Lead"}</span>
                    <span className={`rounded-full px-2 py-0.5 text-xs font-bold ${call.verdict === "fail" ? "bg-red-600 text-white" : "bg-amber-500 text-white"}`}>{call.verdict} · {call.score}</span>
                  </div>
                  <div className="mt-1 space-y-1">
                    {(call.flags || []).map((flag, i) => (
                      <div key={i} className="text-xs text-slate-600"><span className="font-semibold">{flag.check}:</span> {flag.evidence}</div>
                    ))}
                  </div>
                </div>
              ))}
            </div>
          </div>
        )}
        {!auditSummary?.audited && <p className="mt-4 text-sm text-slate-500">No calls audited yet. Audits run nightly, or an admin can trigger a run.</p>}
      </section>

      <section className="mt-8 card p-6">
        <div className="text-xs font-bold uppercase tracking-widest text-emerald-600">Promises to pay</div>
        <h2 className="mt-2 text-xl font-black text-slate-950">Commitments captured on calls</h2>
        <p className="mt-1 text-sm text-slate-500">
          Recorded automatically when a customer states an amount or a date, after their identity is confirmed. Last 30 days.
        </p>
        {promises.length > 0 ? (
          <div className="mt-4 overflow-x-auto">
            <table className="w-full min-w-[640px] text-sm">
              <thead className="bg-slate-50 text-left text-slate-500">
                <tr>
                  <th className="p-3">Customer</th>
                  <th>Promised amount</th>
                  <th>Promised date</th>
                  <th>Captured</th>
                </tr>
              </thead>
              <tbody>
                {promises.map(p => (
                  <tr key={p.id} className="border-t border-slate-200">
                    <td className="p-3 font-semibold text-slate-800">{p.lead_name || p.phone || "Unknown"}</td>
                    <td>{p.promised_amount ? `₹${Number(p.promised_amount).toLocaleString("en-IN")}` : <span className="text-slate-400">not stated</span>}</td>
                    <td>{p.promised_date ? new Date(p.promised_date).toLocaleDateString("en-IN") : <span className="text-slate-400">not stated</span>}</td>
                    <td className="text-xs text-slate-500">{new Date(p.created_at).toLocaleDateString("en-IN")}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        ) : (
          <p className="mt-4 text-sm text-slate-500">No promises to pay captured yet.</p>
        )}
      </section>

      <section className="mt-8 card p-6">
        <div className="flex items-center justify-between gap-4">
          <div>
            <div className="text-xs font-bold uppercase tracking-widest text-violet-600">Shared learning network</div>
            <h2 className="mt-2 text-lg font-black text-slate-950">Learn from the whole network</h2>
            <p className="mt-1 text-sm text-slate-500">Opt in to contribute anonymized question patterns (never answers, brand names, or customer data) and receive suggested replies for questions other lenders' customers ask. All suggestions still require your approval.</p>
          </div>
          <button
            onClick={() => toggleShareLearnings(!settings?.shareLearnings)}
            className={settings?.shareLearnings ? "btn" : "btn-secondary"}
          >{settings?.shareLearnings ? "Enabled — click to leave" : "Join network"}</button>
        </div>
      </section>

      <section className="mt-8 grid grid-cols-1 gap-4 xl:grid-cols-[360px_1fr]">
        <form onSubmit={addDnc} className="card p-6">
          <h2 className="text-lg font-black text-slate-950">Add DNC</h2>
          <input className="input mt-5" placeholder="Phone number, e.g. +918826522604" value={phone} onChange={e => setPhone(e.target.value)} />
          <input className="input mt-3" placeholder="Reason, e.g. customer opted out" value={reason} onChange={e => setReason(e.target.value)} />
          <button className="btn mt-4 w-full">Save</button>
        </form>

        <div className="card overflow-hidden">
          <div className="border-b border-slate-200 p-5">
            <h2 className="text-lg font-black text-slate-950">DNC List</h2>
          </div>
          <div className="overflow-x-auto">
          <table className="w-full min-w-[640px] text-sm">
            <thead className="bg-slate-50 text-left text-slate-500">
              <tr><th className="p-4">Phone</th><th>Reason</th><th>Created</th><th></th></tr>
            </thead>
            <tbody>
              {dnc.map(item => (
                <tr key={item.id} className="border-t border-slate-200">
                  <td className="p-4">{item.phone}</td>
                  <td>{item.reason}</td>
                  <td>{new Date(item.created_at).toLocaleString()}</td>
                  <td className="pr-4 text-right"><button onClick={() => removeDnc(item.phone)} className="btn-secondary">Remove</button></td>
                </tr>
              ))}
              {!dnc.length && <tr><td className="p-4 text-slate-500" colSpan="4">No DNC entries.</td></tr>}
            </tbody>
          </table>
          </div>
        </div>
      </section>

      <section className="mt-8 grid grid-cols-1 gap-4 xl:grid-cols-2">
        <form onSubmit={saveSettings} className="card p-6">
          <h2 className="text-lg font-black text-slate-950">Settings</h2>
          <div className="mt-4 grid grid-cols-2 gap-3">
            <input className="input" type="number" min="0" max="23" placeholder="Start hour, e.g. 9" aria-label="Call window start hour" title="Call window start hour" value={settingsForm?.callWindowStart || 9} onChange={e => setSettingsForm({ ...settingsForm, callWindowStart: Number(e.target.value) })} />
            <input className="input" type="number" min="1" max="24" placeholder="End hour, e.g. 20" aria-label="Call window end hour" title="Call window end hour" value={settingsForm?.callWindowEnd || 20} onChange={e => setSettingsForm({ ...settingsForm, callWindowEnd: Number(e.target.value) })} />
            <input className="input" type="number" min="1" placeholder="Max attempts, e.g. 3" aria-label="Maximum call attempts" title="Maximum call attempts" value={settingsForm?.maxCallAttempts || 3} onChange={e => setSettingsForm({ ...settingsForm, maxCallAttempts: Number(e.target.value) })} />
            <input className="input" type="number" min="1" placeholder="Retry delay minutes, e.g. 360" aria-label="Retry delay in minutes" title="Retry delay in minutes" value={settingsForm?.retryDelayMinutes || 360} onChange={e => setSettingsForm({ ...settingsForm, retryDelayMinutes: Number(e.target.value) })} />
          </div>
          <div className="mt-4 rounded-lg border border-amber-200 bg-amber-50 p-3">
            <div className="text-xs font-bold uppercase tracking-widest text-amber-700">Contact frequency caps</div>
            <p className="mt-1 text-xs text-slate-600">
              Applies per borrower across <strong>all</strong> campaigns, not per campaign. Prevents someone
              enrolled in several campaigns being called repeatedly in one day. Use 0 for no cap.
            </p>
            <div className="mt-3 grid grid-cols-2 gap-3">
              <input
                className="input"
                type="number"
                min="0"
                placeholder="Max calls per day, e.g. 1"
                aria-label="Maximum contacts per borrower per day"
                title="Maximum contacts per borrower per day, across all campaigns"
                value={settingsForm?.maxContactsPerDay ?? 1}
                onChange={e => setSettingsForm({ ...settingsForm, maxContactsPerDay: Number(e.target.value) })}
              />
              <input
                className="input"
                type="number"
                min="0"
                placeholder="Max calls per week, e.g. 3"
                aria-label="Maximum contacts per borrower per week"
                title="Maximum contacts per borrower per week, across all campaigns"
                value={settingsForm?.maxContactsPerWeek ?? 3}
                onChange={e => setSettingsForm({ ...settingsForm, maxContactsPerWeek: Number(e.target.value) })}
              />
            </div>
          </div>
          <textarea className="input mt-3 min-h-24" value={settingsForm?.aiDisclosure || ""} onChange={e => setSettingsForm({ ...settingsForm, aiDisclosure: e.target.value })} placeholder="Call disclosure, e.g. This is Sneha calling from TezCredit about your loan application." />
          <input className="input mt-3" value={settingsForm?.smsWebhookUrl || ""} onChange={e => setSettingsForm({ ...settingsForm, smsWebhookUrl: e.target.value })} placeholder="SMS webhook URL, e.g. https://example.com/sms" />
          <input className="input mt-3" value={settingsForm?.whatsappWebhookUrl || ""} onChange={e => setSettingsForm({ ...settingsForm, whatsappWebhookUrl: e.target.value })} placeholder="WhatsApp webhook URL, e.g. https://example.com/whatsapp" />
          <button className="btn mt-4 w-full">Save Settings</button>
        </form>

        <div className="card p-6">
          <h2 className="text-lg font-black text-slate-950">Rules</h2>
          <div className="mt-4 space-y-2">
            {(settings?.rules || []).map(rule => <div key={rule} className="rounded-lg bg-slate-50 p-3 text-sm text-slate-700">{rule}</div>)}
          </div>
        </div>

        <div className="card overflow-hidden">
          <div className="border-b border-slate-200 p-5">
            <h2 className="text-lg font-black text-slate-950">Compliance Logs</h2>
          </div>
          <div className="max-h-[360px] overflow-auto">
            {logs.map(log => (
              <div key={log.id} className="border-b border-slate-200 p-4 text-sm">
                <div className="flex justify-between gap-4">
                  <span className="font-semibold">{log.rule}: {log.result}</span>
                  <span className="text-slate-500">{log.phone || log.lead_name || "-"}</span>
                </div>
              </div>
            ))}
            {!logs.length && <div className="p-4 text-sm text-slate-500">No compliance events yet.</div>}
          </div>
        </div>
      </section>
    </Shell>
  );
}
