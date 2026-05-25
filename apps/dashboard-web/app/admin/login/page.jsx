"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useEffect, useState } from "react";
import { ShieldCheck } from "lucide-react";
import { API_BASE_URL, getToken, getUser, saveSession } from "../../../lib/api";

export default function AdminLogin() {
  const router = useRouter();
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(false);

  useEffect(() => {
    if (getToken() && getUser()?.role === "admin") router.replace("/admin");
  }, [router]);

  async function submit(e) {
    e.preventDefault();
    setError("");
    setLoading(true);

    try {
      if (!API_BASE_URL) throw new Error("NEXT_PUBLIC_API_BASE_URL is required for Railway deployment.");
      const res = await fetch(`${API_BASE_URL}/auth/admin-login`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ email, password })
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || "Admin login failed");

      saveSession(data);
      router.replace("/admin");
    } catch (err) {
      setError(err.message === "Failed to fetch" ? "Backend API is not reachable." : err.message);
    } finally {
      setLoading(false);
    }
  }

  return (
    <main className="flex min-h-screen items-center justify-center bg-[#05070b] px-6">
      <form onSubmit={submit} className="card w-full max-w-md p-8">
        <div className="flex items-center gap-3">
          <div className="rounded-lg border border-blue-500/30 bg-blue-500/10 p-3 text-blue-300"><ShieldCheck size={22} /></div>
          <div>
            <div className="text-2xl font-black tracking-tight">Admin Console</div>
            <p className="text-sm text-zinc-400">Restricted access for tenant administrators.</p>
          </div>
        </div>

        {error && <div className="mt-6 rounded-lg border border-red-500/30 bg-red-500/10 px-4 py-3 text-sm text-red-200">{error}</div>}

        <label className="mt-6 block text-sm text-zinc-400">Admin Email</label>
        <input className="input mt-2" value={email} onChange={e => setEmail(e.target.value)} type="email" required />

        <label className="mt-4 block text-sm text-zinc-400">Password</label>
        <input className="input mt-2" value={password} onChange={e => setPassword(e.target.value)} type="password" required />

        <button className="btn mt-6 w-full" disabled={loading}>{loading ? "Verifying..." : "Sign in as admin"}</button>
        <Link href="/login" className="mt-4 block text-center text-sm text-zinc-500 hover:text-white">Regular login</Link>
      </form>
    </main>
  );
}
