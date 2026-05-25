"use client";

import Link from "next/link";
import { usePathname, useRouter } from "next/navigation";
import { useEffect, useState } from "react";
import { BarChart3, Bot, FileUp, LayoutDashboard, LogOut, Menu, PhoneCall, ShieldCheck, X } from "lucide-react";
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
  const [menuOpen, setMenuOpen] = useState(false);

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

  const sidebar = (
    <>
      <div className="flex items-start justify-between gap-4">
        <div className="text-2xl font-black tracking-tight">LoanConnect<span className="text-blue-500">AI</span></div>
        <button onClick={() => setMenuOpen(false)} className="rounded-lg border border-white/10 p-2 text-zinc-300 lg:hidden" aria-label="Close menu">
          <X size={18} />
        </button>
      </div>
        <p className="mt-2 text-xs text-zinc-500">BFSI voice operations console</p>
        <nav className="mt-10 space-y-2">
          {nav.map(([label, href, Icon]) => (
            <Link key={href} href={href} onClick={() => setMenuOpen(false)} className={`flex items-center gap-3 rounded-xl px-4 py-3 text-sm hover:bg-white/[0.06] hover:text-white ${pathname === href ? "bg-white/[0.08] text-white" : "text-zinc-300"}`}>
              <Icon size={18} /> {label}
            </Link>
          ))}
        </nav>
        <div className="mt-10 border-t border-white/10 pt-5 lg:absolute lg:bottom-6 lg:left-6 lg:right-6">
          <p className="truncate text-sm font-semibold text-white">{user?.name || "Admin"}</p>
          <p className="truncate text-xs text-zinc-500">{user?.email}</p>
          <button onClick={logout} className="btn-secondary mt-4 flex w-full items-center justify-center gap-2"><LogOut size={16} /> Logout</button>
        </div>
    </>
  );

  return (
    <div className="min-h-screen bg-[#05070b]">
      <header className="sticky top-0 z-30 flex items-center justify-between border-b border-white/10 bg-[#05070b]/95 px-4 py-3 backdrop-blur lg:hidden">
        <div className="text-lg font-black tracking-tight">LoanConnect<span className="text-blue-500">AI</span></div>
        <button onClick={() => setMenuOpen(true)} className="rounded-lg border border-white/10 p-2 text-zinc-200" aria-label="Open menu">
          <Menu size={20} />
        </button>
      </header>
      <aside className="fixed inset-y-0 left-0 hidden w-72 border-r border-white/10 bg-black/40 p-6 lg:block">
        {sidebar}
      </aside>
      {menuOpen && (
        <div className="fixed inset-0 z-40 bg-black/70 lg:hidden">
          <aside className="h-full w-[min(20rem,85vw)] border-r border-white/10 bg-[#080a10] p-6 shadow-2xl">
            {sidebar}
          </aside>
        </div>
      )}
      <main className="min-h-screen p-4 sm:p-6 lg:ml-72 lg:p-8">{children}</main>
    </div>
  );
}
