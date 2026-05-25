"use client";

import { useRouter } from "next/navigation";
import Link from "next/link";
import { useEffect, useState } from "react";
import { API_BASE_URL, getToken, saveSession } from "../../lib/api";

export default function Login() {
  const router = useRouter();
  const [email, setEmail] = useState("admin@loanconnect.ai");
  const [password, setPassword] = useState("Admin@123");
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
    <main className="flex min-h-screen items-center justify-center bg-[#05070b] px-6">
      <form onSubmit={submit} className="card w-full max-w-md p-8">
        <div className="text-3xl font-black tracking-tight">LoanConnect<span className="text-blue-500">AI</span></div>
        <p className="mt-2 text-sm text-zinc-400">Sign in to manage campaigns, leads and call queues.</p>

        {error && <div className="mt-6 rounded-xl border border-red-500/30 bg-red-500/10 px-4 py-3 text-sm text-red-200">{error}</div>}

        <label className="mt-6 block text-sm text-zinc-400">Email</label>
        <input className="input mt-2" value={email} onChange={e => setEmail(e.target.value)} type="email" required />

        <label className="mt-4 block text-sm text-zinc-400">Password</label>
        <input className="input mt-2" value={password} onChange={e => setPassword(e.target.value)} type="password" required />

        <button className="btn mt-6 w-full" disabled={loading}>{loading ? "Signing in..." : "Sign in"}</button>
        <Link href="/admin/login" className="mt-4 block text-center text-sm text-zinc-500 hover:text-white">Admin login</Link>
      </form>
    </main>
  );
}
