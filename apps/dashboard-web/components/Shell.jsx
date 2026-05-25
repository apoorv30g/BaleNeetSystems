"use client";

import Link from "next/link";
import { usePathname, useRouter } from "next/navigation";
import { useEffect, useState } from "react";
import { BarChart3, Bot, FileUp, LayoutDashboard, PhoneCall, ShieldCheck } from "lucide-react";
import { clearSession, getToken, getUser } from "../lib/api";

const nav = [
  ["Dashboard", "/", LayoutDashboard],
  ["Campaigns", "/campaigns", PhoneCall],
  ["Playbooks", "/playbooks", Bot],
  ["Upload Leads", "/upload", FileUp],
  ["Analytics", "/analytics", BarChart3],
  ["Compliance", "/compliance", ShieldCheck]
];

export default function Shell({ children }) {
  const router = useRouter();
  const pathname = usePathname();
  const [ready, setReady] = useState(false);
  const [user, setUser] = useState(null);

  useEffect(() => {
    const token = getToken();
    if (!token) {
      router.replace("/login");
      return;
    }

    setUser(getUser());
    setReady(true);
  }, [router]);

  function logout() {
    clearSession();
    router.replace("/login");
  }

  if (!ready) {
    return <div className="flex min-h-screen items-center justify-center bg-[#05070b] text-sm text-zinc-400">Loading console...</div>;
  }

  return (
    <div className="min-h-screen bg-[#05070b]">
      <aside className="fixed inset-y-0 left-0 w-72 border-r border-white/10 bg-black/40 p-6">
        <div className="text-2xl font-black tracking-tight">LoanConnect<span className="text-blue-500">AI</span></div>
        <p className="mt-2 text-xs text-zinc-500">BFSI voice operations console</p>
        <nav className="mt-10 space-y-2">
          {nav.map(([label, href, Icon]) => (
            <Link key={href} href={href} className={`flex items-center gap-3 rounded-xl px-4 py-3 text-sm hover:bg-white/[0.06] hover:text-white ${pathname === href ? "bg-white/[0.08] text-white" : "text-zinc-300"}`}>
              <Icon size={18} /> {label}
            </Link>
          ))}
        </nav>
        <div className="absolute bottom-6 left-6 right-6 border-t border-white/10 pt-5">
          <p className="truncate text-sm font-semibold text-white">{user?.name || "Admin"}</p>
          <p className="truncate text-xs text-zinc-500">{user?.email}</p>
          <button onClick={logout} className="btn-secondary mt-4 w-full">Logout</button>
        </div>
      </aside>
      <main className="ml-72 min-h-screen p-8">{children}</main>
    </div>
  );
}
