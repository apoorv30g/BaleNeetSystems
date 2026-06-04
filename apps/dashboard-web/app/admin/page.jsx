"use client";

import { useEffect, useMemo, useState } from "react";
import { useRouter } from "next/navigation";
import Link from "next/link";
import { Building2, CheckCircle2, KeyRound, LogOut, Plus, ShieldCheck, Sparkles, UserPlus, XCircle } from "lucide-react";
import { apiFetch, clearSession, getUser } from "../../lib/api";

const blankClient = { clientName: "", planType: "starter", adminName: "", adminEmail: "", adminPassword: "" };
const blankUser = { name: "", email: "", password: "", role: "operator" };

export default function AdminPage() {
  const router = useRouter();
  const [overview, setOverview] = useState(null);
  const [clientForm, setClientForm] = useState(blankClient);
  const [selectedClient, setSelectedClient] = useState("");
  const [clientUsers, setClientUsers] = useState([]);
  const [userForm, setUserForm] = useState(blankUser);
  const [message, setMessage] = useState("");
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(false);

  useEffect(() => {
    const user = getUser();
    if (!user || !["platform_admin", "admin"].includes(user.role)) {
      router.replace("/admin/login");
      return;
    }
    load().catch(err => setError(err.message));
  }, [router]);

  async function load() {
    const data = await apiFetch("/admin/overview");
    setOverview(data);
    const firstClient = data.clients?.[0]?.id || "";
    if (!selectedClient && firstClient) {
      setSelectedClient(firstClient);
      loadClientUsers(firstClient).catch(() => {});
    }
  }

  async function loadClientUsers(tenantId) {
    if (!tenantId) {
      setClientUsers([]);
      return;
    }
    setClientUsers(await apiFetch(`/admin/clients/${tenantId}/users`));
  }

  async function onboardClient(e) {
    e.preventDefault();
    await run(async () => {
      const result = await apiFetch("/admin/clients", { method: "POST", body: JSON.stringify(clientForm) });
      setClientForm(blankClient);
      setSelectedClient(result.tenant.id);
      await load();
      await loadClientUsers(result.tenant.id);
    }, "Client onboarded. Share the client login email and temporary password.");
  }

  async function createClientUser(e) {
    e.preventDefault();
    if (!selectedClient) return;
    await run(async () => {
      await apiFetch(`/admin/clients/${selectedClient}/users`, { method: "POST", body: JSON.stringify(userForm) });
      setUserForm(blankUser);
      await loadClientUsers(selectedClient);
      await load();
    }, "Client user created.");
  }

  async function run(action, success) {
    setLoading(true);
    setError("");
    setMessage("");
    try {
      await action();
      setMessage(success);
    } catch (err) {
      setError(err.message);
    } finally {
      setLoading(false);
    }
  }

  function logout() {
    clearSession();
    router.replace("/admin/login");
  }

  const providerRows = useMemo(() => {
    const status = overview?.providerStatus || {};
    return [
      ["Database", status.database === "ok"],
      ["Redis / Queue", status.redis === "ok"],
      ["Exotel", status.exotel],
      ["Sarvam", status.sarvam],
      ["Gemini fallback", status.gemini],
      ["Deepgram fallback", status.deepgram],
      ["API URL", status.serverUrl],
      ["App URL", status.frontendUrl]
    ];
  }, [overview]);

  const counts = overview?.counts || {};
  const selectedClientName = overview?.clients?.find(client => client.id === selectedClient)?.name || "Select client";

  return (
    <main className="min-h-screen bg-slate-50">
      <header className="border-b border-slate-200 bg-white/90 px-4 py-4 shadow-sm backdrop-blur sm:px-6 lg:px-8">
        <div className="mx-auto flex max-w-7xl items-center justify-between gap-4">
          <div className="flex items-center gap-3">
            <div className="brand-mark"><ShieldCheck size={18} /></div>
            <div>
              <h1 className="text-xl font-black text-slate-950">Platform Admin</h1>
              <p className="text-xs font-medium text-slate-500">Client onboarding and system readiness</p>
            </div>
          </div>
          <button className="btn-secondary px-4 py-2" onClick={logout}><LogOut size={16} /> Logout</button>
        </div>
        <nav className="mx-auto mt-4 flex max-w-7xl gap-2">
          <Link className="btn px-4 py-2" href="/admin">Overview</Link>
          <Link className="btn-secondary px-4 py-2" href="/admin/costs">Costs</Link>
        </nav>
      </header>

      <div className="mx-auto max-w-7xl px-4 py-6 sm:px-6 lg:px-8">
        <section className="overflow-hidden rounded-lg border border-slate-200 bg-slate-950 text-white shadow-xl shadow-slate-200">
          <div className="grid gap-6 p-6 lg:grid-cols-[1.4fr_1fr] lg:p-8">
            <div>
              <div className="inline-flex items-center gap-2 rounded-full bg-white/10 px-3 py-1 text-xs font-semibold text-sky-100">
                <Sparkles size={14} /> Multi-client control plane
              </div>
              <h2 className="mt-5 max-w-2xl text-3xl font-black sm:text-4xl">Onboard clients, then let their teams run campaigns independently.</h2>
              <p className="mt-3 max-w-2xl text-sm leading-6 text-slate-300">
                Client logins stay tenant-scoped. They can create campaigns, upload leads, manage playbooks and review outcomes without seeing platform admin work.
              </p>
            </div>
            <div className="grid grid-cols-2 gap-3">
              <Metric label="Clients" value={counts.tenants || 0} />
              <Metric label="Client Users" value={counts.client_users || 0} />
              <Metric label="Campaigns" value={counts.campaigns || 0} />
              <Metric label="Calls" value={counts.calls || 0} />
            </div>
          </div>
        </section>

        {error && <div className="mt-6 rounded-lg border border-red-200 bg-red-50 px-4 py-3 text-sm text-red-700">{error}</div>}
        {message && <div className="mt-6 rounded-lg border border-emerald-200 bg-emerald-50 px-4 py-3 text-sm text-emerald-700">{message}</div>}

        <section className="mt-6 grid grid-cols-1 gap-5 xl:grid-cols-[1fr_420px]">
          <div className="card overflow-hidden">
            <div className="flex flex-col gap-3 border-b border-slate-200 p-5 sm:flex-row sm:items-center sm:justify-between">
              <div>
                <h2 className="text-lg font-black text-slate-950">Clients</h2>
                <p className="text-sm text-slate-500">Each client has isolated campaigns, leads, calls and playbooks.</p>
              </div>
              <span className="status-pill">{overview?.clients?.length || 0} onboarded</span>
            </div>
            <div className="overflow-x-auto">
              <table className="w-full min-w-[760px] text-sm">
                <thead className="bg-slate-50 text-left text-slate-500">
                  <tr><th className="p-4">Client</th><th>Login</th><th>Plan</th><th>Users</th><th>Campaigns</th><th>Calls</th><th></th></tr>
                </thead>
                <tbody>
                  {(overview?.clients || []).map(client => (
                    <tr key={client.id} className="border-t border-slate-200">
                      <td className="p-4">
                        <div className="font-bold text-slate-950">{client.name}</div>
                        <div className="text-xs text-slate-500">{formatDate(client.created_at)}</div>
                      </td>
                      <td className="text-slate-600">{client.primary_email || "-"}</td>
                      <td><span className="status-pill">{client.plan_type}</span></td>
                      <td>{client.users || 0}</td>
                      <td>{client.campaigns || 0}</td>
                      <td>{client.calls || 0}</td>
                      <td className="pr-4 text-right">
                        <button className="btn-secondary px-3 py-2" onClick={() => { setSelectedClient(client.id); loadClientUsers(client.id); }}>
                          Manage
                        </button>
                      </td>
                    </tr>
                  ))}
                  {!overview?.clients?.length && <tr><td className="p-4 text-slate-500" colSpan="7">No clients onboarded yet.</td></tr>}
                </tbody>
              </table>
            </div>
          </div>

          <form onSubmit={onboardClient} className="card p-5">
            <div className="flex items-center gap-3">
              <div className="grid h-10 w-10 place-items-center rounded-lg bg-emerald-100 text-emerald-700"><Building2 size={18} /></div>
              <div>
                <h2 className="text-lg font-black text-slate-950">Onboard Client</h2>
                <p className="text-sm text-slate-500">Create tenant and first login.</p>
              </div>
            </div>
            <input className="input mt-5" placeholder="Client company name" value={clientForm.clientName} onChange={e => setClientForm({ ...clientForm, clientName: e.target.value })} required />
            <select className="input mt-3" value={clientForm.planType} onChange={e => setClientForm({ ...clientForm, planType: e.target.value })}>
              <option value="starter">Starter</option>
              <option value="growth">Growth</option>
              <option value="enterprise">Enterprise</option>
            </select>
            <input className="input mt-3" placeholder="Client user name" value={clientForm.adminName} onChange={e => setClientForm({ ...clientForm, adminName: e.target.value })} />
            <input className="input mt-3" placeholder="Client login email" type="email" value={clientForm.adminEmail} onChange={e => setClientForm({ ...clientForm, adminEmail: e.target.value })} required />
            <input className="input mt-3" placeholder="Temporary password" type="password" value={clientForm.adminPassword} onChange={e => setClientForm({ ...clientForm, adminPassword: e.target.value })} required />
            <button className="btn mt-4 w-full" disabled={loading}><Plus size={16} /> Create Client</button>
          </form>
        </section>

        <section className="mt-6 grid grid-cols-1 gap-5 xl:grid-cols-[420px_1fr]">
          <form onSubmit={createClientUser} className="card p-5">
            <div className="flex items-center gap-3">
              <div className="grid h-10 w-10 place-items-center rounded-lg bg-sky-100 text-sky-700"><UserPlus size={18} /></div>
              <div>
                <h2 className="text-lg font-black text-slate-950">Add Client User</h2>
                <p className="text-sm text-slate-500">{selectedClientName}</p>
              </div>
            </div>
            <select className="input mt-5" value={selectedClient} onChange={e => { setSelectedClient(e.target.value); loadClientUsers(e.target.value); }}>
              {(overview?.clients || []).map(client => <option key={client.id} value={client.id}>{client.name}</option>)}
            </select>
            <input className="input mt-3" placeholder="Name" value={userForm.name} onChange={e => setUserForm({ ...userForm, name: e.target.value })} />
            <input className="input mt-3" placeholder="Email" type="email" value={userForm.email} onChange={e => setUserForm({ ...userForm, email: e.target.value })} required />
            <input className="input mt-3" placeholder="Temporary password" type="password" value={userForm.password} onChange={e => setUserForm({ ...userForm, password: e.target.value })} required />
            <select className="input mt-3" value={userForm.role} onChange={e => setUserForm({ ...userForm, role: e.target.value })}>
              <option value="operator">Operator</option>
              <option value="viewer">Viewer</option>
            </select>
            <button className="btn mt-4 w-full" disabled={loading || !selectedClient}><KeyRound size={16} /> Create Login</button>
          </form>

          <div className="card overflow-hidden">
            <div className="border-b border-slate-200 p-5">
              <h2 className="text-lg font-black text-slate-950">Users for {selectedClientName}</h2>
              <p className="text-sm text-slate-500">These users sign in from the normal client login.</p>
            </div>
            <div className="overflow-x-auto">
              <table className="w-full min-w-[560px] text-sm">
                <thead className="bg-slate-50 text-left text-slate-500">
                  <tr><th className="p-4">Name</th><th>Email</th><th>Role</th><th>Created</th></tr>
                </thead>
                <tbody>
                  {clientUsers.map(user => (
                    <tr key={user.id} className="border-t border-slate-200">
                      <td className="p-4 font-semibold text-slate-950">{user.name || "-"}</td>
                      <td>{user.email}</td>
                      <td><span className="status-pill">{user.role}</span></td>
                      <td className="text-slate-500">{formatDate(user.created_at)}</td>
                    </tr>
                  ))}
                  {!clientUsers.length && <tr><td className="p-4 text-slate-500" colSpan="4">No users for this client yet.</td></tr>}
                </tbody>
              </table>
            </div>
          </div>
        </section>

        <section className="mt-6 grid grid-cols-1 gap-5 xl:grid-cols-2">
          <div className="card p-5">
            <h2 className="text-lg font-black text-slate-950">Provider Readiness</h2>
            <div className="mt-5 grid grid-cols-1 gap-2 sm:grid-cols-2">
              {providerRows.map(([label, ok]) => (
                <div key={label} className="flex items-center justify-between rounded-lg border border-slate-200 bg-slate-50 px-4 py-3 text-sm">
                  <span className="font-semibold text-slate-700">{label}</span>
                  {ok ? <CheckCircle2 className="text-emerald-500" size={18} /> : <XCircle className="text-red-500" size={18} />}
                </div>
              ))}
            </div>
          </div>

          <div className="card overflow-hidden">
            <div className="border-b border-slate-200 p-5">
              <h2 className="text-lg font-black text-slate-950">Audit Trail</h2>
            </div>
            <div className="max-h-[320px] overflow-auto">
              {(overview?.auditLogs || []).map(log => (
                <div key={log.id} className="border-b border-slate-200 p-4 text-sm">
                  <div className="flex flex-wrap items-center justify-between gap-3">
                    <span className="font-semibold text-slate-950">{log.action}</span>
                    <span className="text-xs text-slate-500">{formatDate(log.created_at)}</span>
                  </div>
                  <p className="mt-1 text-xs text-slate-500">{log.user_email || "system"} {log.tenant_name ? `- ${log.tenant_name}` : ""}</p>
                </div>
              ))}
              {!overview?.auditLogs?.length && <div className="p-4 text-sm text-slate-500">No audit logs yet.</div>}
            </div>
          </div>
        </section>
      </div>
    </main>
  );
}

function Metric({ label, value }) {
  return (
    <div className="rounded-lg border border-white/10 bg-white/10 p-4">
      <p className="text-xs font-semibold uppercase tracking-wide text-slate-300">{label}</p>
      <p className="mt-2 text-3xl font-black text-white">{value}</p>
    </div>
  );
}

function formatDate(value) {
  if (!value) return "-";
  return new Date(value).toLocaleString();
}
