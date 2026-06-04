"use client";

import { useRouter } from "next/navigation";
import Link from "next/link";
import { useEffect, useState } from "react";
import { LockKeyhole, PhoneCall, Sparkles } from "lucide-react";
import { API_BASE_URL, getToken, saveSession } from "../../lib/api";

export default function Login() {
  const router = useRouter();
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(false);

  useEffect(() => {
    if (getToken()) router.replace("/");
  }, [router]);

  async function submit(e) {
    e.preventDefault();
    setError("");
    setLoading(true);

    try {
      if (!API_BASE_URL) throw new Error("NEXT_PUBLIC_API_BASE_URL is required for Railway deployment.");
      const res = await fetch(`${API_BASE_URL}/auth/login`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ email, password })
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || "Login failed");

      saveSession(data);
      router.replace("/");
    } catch (err) {
      setError(err.message === "Failed to fetch" ? "Backend API is not reachable. Check NEXT_PUBLIC_API_BASE_URL and the Railway backend domain." : err.message);
    } finally {
      setLoading(false);
    }
  }

  return (
    <main className="grid min-h-screen bg-slate-50 lg:grid-cols-[1.05fr_0.95fr]">
      <section className="hidden min-h-screen bg-slate-950 p-10 text-white lg:flex lg:flex-col lg:justify-between">
        <div className="flex items-center gap-3">
          <div className="brand-mark"><Sparkles size={18} /></div>
          <div className="text-2xl font-black tracking-tight">LoanConnect<span className="text-sky-300">AI</span></div>
        </div>
        <div>
          <div className="inline-flex items-center gap-2 rounded-full bg-white/10 px-3 py-1 text-xs font-semibold text-sky-100">
            <PhoneCall size={14} /> Client workspace
          </div>
          <h1 className="mt-5 max-w-xl text-5xl font-black leading-tight">Run voice campaigns with cleaner queues and clearer outcomes.</h1>
          <p className="mt-4 max-w-lg text-sm leading-6 text-slate-300">Create campaigns, upload leads, tune playbooks and track call intent from one focused console.</p>
        </div>
      </section>

      <section className="flex min-h-screen items-center justify-center px-6 py-10">
      <form onSubmit={submit} className="card w-full max-w-md p-8">
        <div className="flex items-center gap-3">
          <div className="grid h-11 w-11 place-items-center rounded-lg bg-sky-100 text-sky-700"><LockKeyhole size={20} /></div>
          <div>
            <div className="text-2xl font-black tracking-tight text-slate-950">Client Login</div>
            <p className="text-sm text-slate-500">Campaign, lead and call operations.</p>
          </div>
        </div>

        {error && <div className="mt-6 rounded-lg border border-red-200 bg-red-50 px-4 py-3 text-sm text-red-700">{error}</div>}

        <label className="mt-6 block text-sm font-semibold text-slate-600">Email</label>
        <input className="input mt-2" value={email} onChange={e => setEmail(e.target.value)} type="email" required />

        <label className="mt-4 block text-sm font-semibold text-slate-600">Password</label>
        <input className="input mt-2" value={password} onChange={e => setPassword(e.target.value)} type="password" required />

        <button className="btn mt-6 w-full" disabled={loading}>{loading ? "Signing in..." : "Sign in"}</button>
        <Link href="/admin/login" className="mt-4 block text-center text-sm font-semibold text-slate-500 hover:text-sky-700">Platform admin login</Link>
      </form>
      </section>
    </main>
  );
}
