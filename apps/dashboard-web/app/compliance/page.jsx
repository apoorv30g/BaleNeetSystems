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
      <h1 className="text-4xl font-black">Compliance</h1>
      <p className="mt-2 text-zinc-400">Operational guardrails, DNC controls and compliance events.</p>

      {error && <div className="mt-6 rounded-xl border border-red-500/30 bg-red-500/10 px-4 py-3 text-sm text-red-200">{error}</div>}
      {message && <div className="mt-6 rounded-xl border border-emerald-500/30 bg-emerald-500/10 px-4 py-3 text-sm text-emerald-200">{message}</div>}

      <section className="mt-8 grid grid-cols-4 gap-4">
        <div className="card p-5"><p className="text-sm text-zinc-500">Call Window</p><p className="mt-3 text-3xl font-black">{settings?.callWindowStart || 9}:00-{settings?.callWindowEnd || 20}:00</p></div>
        <div className="card p-5"><p className="text-sm text-zinc-500">Max Attempts</p><p className="mt-3 text-3xl font-black">{settings?.maxCallAttempts || 3}</p></div>
        <div className="card p-5"><p className="text-sm text-zinc-500">Retry Delay</p><p className="mt-3 text-3xl font-black">{settings?.retryDelayMinutes || 360}m</p></div>
        <div className="card p-5"><p className="text-sm text-zinc-500">DNC Entries</p><p className="mt-3 text-3xl font-black">{dnc.length}</p></div>
      </section>

      <section className="mt-8 grid grid-cols-[360px_1fr] gap-4">
        <form onSubmit={addDnc} className="card p-6">
          <h2 className="text-lg font-bold">Add DNC</h2>
          <input className="input mt-5" placeholder="Phone number" value={phone} onChange={e => setPhone(e.target.value)} />
          <input className="input mt-3" placeholder="Reason" value={reason} onChange={e => setReason(e.target.value)} />
          <button className="btn mt-4 w-full">Save</button>
        </form>

        <div className="card overflow-hidden">
          <div className="border-b border-white/10 p-5">
            <h2 className="text-lg font-bold">DNC List</h2>
          </div>
          <table className="w-full text-sm">
            <thead className="bg-white/[0.04] text-left text-zinc-400">
              <tr><th className="p-4">Phone</th><th>Reason</th><th>Created</th><th></th></tr>
            </thead>
            <tbody>
              {dnc.map(item => (
                <tr key={item.id} className="border-t border-white/10">
                  <td className="p-4">{item.phone}</td>
                  <td>{item.reason}</td>
                  <td>{new Date(item.created_at).toLocaleString()}</td>
                  <td className="pr-4 text-right"><button onClick={() => removeDnc(item.phone)} className="btn-secondary">Remove</button></td>
                </tr>
              ))}
              {!dnc.length && <tr><td className="p-4 text-zinc-500" colSpan="4">No DNC entries.</td></tr>}
            </tbody>
          </table>
        </div>
      </section>

      <section className="mt-8 grid grid-cols-2 gap-4">
        <form onSubmit={saveSettings} className="card p-6">
          <h2 className="text-lg font-bold">Settings</h2>
          <div className="mt-4 grid grid-cols-2 gap-3">
            <input className="input" type="number" min="0" max="23" value={settingsForm?.callWindowStart || 9} onChange={e => setSettingsForm({ ...settingsForm, callWindowStart: Number(e.target.value) })} />
            <input className="input" type="number" min="1" max="24" value={settingsForm?.callWindowEnd || 20} onChange={e => setSettingsForm({ ...settingsForm, callWindowEnd: Number(e.target.value) })} />
            <input className="input" type="number" min="1" value={settingsForm?.maxCallAttempts || 3} onChange={e => setSettingsForm({ ...settingsForm, maxCallAttempts: Number(e.target.value) })} />
            <input className="input" type="number" min="1" value={settingsForm?.retryDelayMinutes || 360} onChange={e => setSettingsForm({ ...settingsForm, retryDelayMinutes: Number(e.target.value) })} />
          </div>
          <textarea className="input mt-3 min-h-24" value={settingsForm?.aiDisclosure || ""} onChange={e => setSettingsForm({ ...settingsForm, aiDisclosure: e.target.value })} placeholder="AI disclosure" />
          <input className="input mt-3" value={settingsForm?.smsWebhookUrl || ""} onChange={e => setSettingsForm({ ...settingsForm, smsWebhookUrl: e.target.value })} placeholder="SMS webhook URL" />
          <input className="input mt-3" value={settingsForm?.whatsappWebhookUrl || ""} onChange={e => setSettingsForm({ ...settingsForm, whatsappWebhookUrl: e.target.value })} placeholder="WhatsApp webhook URL" />
          <button className="btn mt-4 w-full">Save Settings</button>
        </form>

        <div className="card p-6">
          <h2 className="text-lg font-bold">Rules</h2>
          <div className="mt-4 space-y-2">
            {(settings?.rules || []).map(rule => <div key={rule} className="rounded-xl bg-white/[0.04] p-3 text-sm">{rule}</div>)}
          </div>
        </div>

        <div className="card overflow-hidden">
          <div className="border-b border-white/10 p-5">
            <h2 className="text-lg font-bold">Compliance Logs</h2>
          </div>
          <div className="max-h-[360px] overflow-auto">
            {logs.map(log => (
              <div key={log.id} className="border-b border-white/10 p-4 text-sm">
                <div className="flex justify-between gap-4">
                  <span className="font-semibold">{log.rule}: {log.result}</span>
                  <span className="text-zinc-500">{log.phone || log.lead_name || "-"}</span>
                </div>
              </div>
            ))}
            {!logs.length && <div className="p-4 text-sm text-zinc-500">No compliance events yet.</div>}
          </div>
        </div>
      </section>
    </Shell>
  );
}
