"use client";

import { useEffect, useMemo, useState } from "react";
import { useRouter } from "next/navigation";
import { CheckCircle2, KeyRound, Plus, ShieldAlert, Trash2, XCircle } from "lucide-react";
import Shell from "../../components/Shell";
import { apiFetch, getUser } from "../../lib/api";

const blankUser = { name: "", email: "", password: "", role: "operator" };

export default function AdminPage() {
  const router = useRouter();
  const [overview, setOverview] = useState(null);
  const [userForm, setUserForm] = useState(blankUser);
  const [message, setMessage] = useState("");
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(false);

  useEffect(() => {
    const user = getUser();
    if (user && user.role !== "admin") {
      router.replace("/");
      return;
    }
    load().catch(err => {
      if (err.message === "Forbidden") router.replace("/admin/login");
      else setError(err.message);
    });
  }, [router]);

  async function load() {
    setOverview(await apiFetch("/admin/overview"));
  }

  async function run(action, success) {
    setLoading(true);
    setError("");
    setMessage("");
    try {
      await action();
      setMessage(success);
      await load();
    } catch (err) {
      setError(err.message);
    } finally {
      setLoading(false);
    }
  }

  async function createUser(e) {
    e.preventDefault();
    await run(
      () => apiFetch("/admin/users", { method: "POST", body: JSON.stringify(userForm) }),
      "User created."
    );
    setUserForm(blankUser);
  }

  async function updateUser(userId, patch) {
    await run(
      () => apiFetch(`/admin/users/${userId}`, { method: "PATCH", body: JSON.stringify(patch) }),
      "User updated."
    );
  }

  async function deleteUser(userId) {
    if (!confirm("Delete this user?")) return;
    await run(
      () => apiFetch(`/admin/users/${userId}`, { method: "DELETE" }),
      "User deleted."
    );
  }

  const providerRows = useMemo(() => {
    const status = overview?.providerStatus || {};
    return [
      ["Database", status.database === "ok"],
      ["Redis / Queue", status.redis === "ok"],
      ["Exotel", status.exotel],
      ["Gemini", status.gemini],
      ["Deepgram", status.deepgram],
      ["Sarvam", status.sarvam],
      ["Server URL", status.serverUrl],
      ["Frontend URL", status.frontendUrl]
    ];
  }, [overview]);

  const cards = [
    ["Campaigns", sumCounts(overview?.counts?.campaigns)],
    ["Leads", sumCounts(overview?.counts?.leads)],
    ["Calls", sumCounts(overview?.counts?.calls)],
    ["Users", overview?.users?.length || 0]
  ];

  return (
    <Shell>
      <div className="flex flex-col gap-2">
        <h1 className="text-3xl font-black sm:text-4xl">Admin</h1>
        <p className="text-sm text-zinc-400">Manage access, provider readiness, tenant settings and audit trail.</p>
      </div>

      {error && <div className="mt-6 rounded-lg border border-red-500/30 bg-red-500/10 px-4 py-3 text-sm text-red-200">{error}</div>}
      {message && <div className="mt-6 rounded-lg border border-emerald-500/30 bg-emerald-500/10 px-4 py-3 text-sm text-emerald-200">{message}</div>}

      <section className="mt-8 grid grid-cols-2 gap-3 lg:grid-cols-4">
        {cards.map(([label, value]) => (
          <div className="card p-4" key={label}>
            <p className="text-xs text-zinc-500">{label}</p>
            <p className="mt-2 text-2xl font-black">{value}</p>
          </div>
        ))}
      </section>

      <section className="mt-8 grid grid-cols-1 gap-4 xl:grid-cols-[1fr_420px]">
        <div className="card p-5">
          <div className="flex items-center justify-between gap-4">
            <h2 className="text-lg font-bold">Team Users</h2>
            <span className="text-xs text-zinc-500">{overview?.tenant?.name || "Tenant"}</span>
          </div>
          <div className="mt-5 overflow-x-auto">
            <table className="w-full min-w-[720px] text-sm">
              <thead className="bg-white/[0.04] text-left text-zinc-400">
                <tr><th className="p-3">Name</th><th>Email</th><th>Role</th><th>Created</th><th></th></tr>
              </thead>
              <tbody>
                {(overview?.users || []).map(user => (
                  <tr key={user.id} className="border-t border-white/10">
                    <td className="p-3">{user.name || "-"}</td>
                    <td>{user.email}</td>
                    <td>
                      <select className="input max-w-36 py-2" value={user.role} onChange={e => updateUser(user.id, { role: e.target.value })}>
                        <option value="admin">admin</option>
                        <option value="operator">operator</option>
                        <option value="viewer">viewer</option>
                      </select>
                    </td>
                    <td className="text-zinc-500">{formatDate(user.created_at)}</td>
                    <td className="pr-3 text-right">
                      <button className="btn-secondary px-3 py-2" onClick={() => deleteUser(user.id)} disabled={loading}><Trash2 size={15} /></button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>

        <form onSubmit={createUser} className="card p-5">
          <h2 className="text-lg font-bold">Create User</h2>
          <input className="input mt-5" placeholder="Name" value={userForm.name} onChange={e => setUserForm({ ...userForm, name: e.target.value })} />
          <input className="input mt-3" placeholder="Email" type="email" value={userForm.email} onChange={e => setUserForm({ ...userForm, email: e.target.value })} required />
          <input className="input mt-3" placeholder="Temporary password" type="password" value={userForm.password} onChange={e => setUserForm({ ...userForm, password: e.target.value })} required />
          <select className="input mt-3" value={userForm.role} onChange={e => setUserForm({ ...userForm, role: e.target.value })}>
            <option value="operator">operator</option>
            <option value="viewer">viewer</option>
            <option value="admin">admin</option>
          </select>
          <button className="btn mt-4 w-full" disabled={loading}><Plus size={16} /> Create User</button>
        </form>
      </section>

      <section className="mt-8 grid grid-cols-1 gap-4 xl:grid-cols-2">
        <div className="card p-5">
          <h2 className="text-lg font-bold">Provider Readiness</h2>
          <div className="mt-5 grid grid-cols-1 gap-2 sm:grid-cols-2">
            {providerRows.map(([label, ok]) => (
              <div key={label} className="flex items-center justify-between rounded-lg bg-white/[0.04] px-4 py-3 text-sm">
                <span>{label}</span>
                {ok ? <CheckCircle2 className="text-emerald-400" size={18} /> : <XCircle className="text-red-300" size={18} />}
              </div>
            ))}
          </div>
        </div>

        <div className="card p-5">
          <h2 className="text-lg font-bold">Tenant Settings</h2>
          <div className="mt-5 grid gap-2 text-sm">
            <Setting label="Call Window" value={`${overview?.settings?.callWindowStart ?? "-"}:00 - ${overview?.settings?.callWindowEnd ?? "-"}:00`} />
            <Setting label="Max Attempts" value={overview?.settings?.maxCallAttempts ?? "-"} />
            <Setting label="Retry Delay" value={`${overview?.settings?.retryDelayMinutes ?? "-"} minutes`} />
            <Setting label="AI Disclosure" value={overview?.settings?.aiDisclosure || "-"} />
          </div>
        </div>
      </section>

      <section className="card mt-8 overflow-hidden">
        <div className="flex items-center gap-2 border-b border-white/10 p-5">
          <KeyRound size={18} className="text-blue-300" />
          <h2 className="text-lg font-bold">Audit Trail</h2>
        </div>
        <div className="max-h-[430px] overflow-auto">
          {(overview?.auditLogs || []).map(log => (
            <div key={log.id} className="border-b border-white/10 p-4 text-sm">
              <div className="flex flex-wrap items-center justify-between gap-3">
                <span className="font-semibold text-white">{log.action}</span>
                <span className="text-xs text-zinc-500">{formatDate(log.created_at)}</span>
              </div>
              <p className="mt-1 text-xs text-zinc-500">{log.user_email || "system"}</p>
              <pre className="mt-3 overflow-auto rounded-lg bg-black/30 p-3 text-xs text-zinc-400">{JSON.stringify(log.details || {}, null, 2)}</pre>
            </div>
          ))}
          {!overview?.auditLogs?.length && <div className="p-4 text-sm text-zinc-500"><ShieldAlert className="mr-2 inline" size={16} />No audit logs yet.</div>}
        </div>
      </section>
    </Shell>
  );
}

function Setting({ label, value }) {
  return (
    <div className="rounded-lg bg-white/[0.04] p-3">
      <span className="text-zinc-500">{label}: </span>{value}
    </div>
  );
}

function sumCounts(counts = {}) {
  return Object.values(counts).reduce((sum, value) => sum + Number(value || 0), 0);
}

function formatDate(value) {
  if (!value) return "-";
  return new Date(value).toLocaleString();
}
