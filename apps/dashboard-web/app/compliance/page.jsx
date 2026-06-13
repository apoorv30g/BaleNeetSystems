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
          <textarea className="input mt-3 min-h-24" value={settingsForm?.aiDisclosure || ""} onChange={e => setSettingsForm({ ...settingsForm, aiDisclosure: e.target.value })} placeholder="AI disclosure, e.g. This is an AI assistant calling from LoanConnect." />
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
