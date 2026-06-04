"use client";

import Link from "next/link";
import { usePathname, useRouter } from "next/navigation";
import { useEffect, useState } from "react";
import { BarChart3, Bot, FileUp, LayoutDashboard, LogOut, Menu, PhoneCall, ShieldCheck, Sparkles, X } from "lucide-react";
import { clearSession, getToken, getUser } from "../lib/api";

const baseNav = [
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

    const currentUser = getUser();
    if (currentUser?.role === "platform_admin") {
      router.replace("/admin");
      return;
    }
    setUser(currentUser);
    setReady(true);
  }, [router]);

  function logout() {
    clearSession();
    router.replace("/login");
  }

  if (!ready) {
    return <div className="flex min-h-screen items-center justify-center bg-slate-50 text-sm text-slate-500">Loading console...</div>;
  }

  const nav = baseNav;

  const sidebar = (
    <>
      <div className="flex items-start justify-between gap-4">
        <div className="flex items-center gap-3">
          <div className="brand-mark"><Sparkles size={18} /></div>
          <div>
            <div className="text-xl font-black tracking-tight text-slate-950">LoanConnect<span className="text-sky-600">AI</span></div>
            <p className="text-xs font-medium text-slate-500">Voice operations console</p>
          </div>
        </div>
        <button onClick={() => setMenuOpen(false)} className="rounded-lg border border-slate-200 bg-white p-2 text-slate-600 lg:hidden" aria-label="Close menu">
          <X size={18} />
        </button>
      </div>
        <nav className="mt-10 space-y-2">
          {nav.map(([label, href, Icon]) => (
            <Link key={href} href={href} onClick={() => setMenuOpen(false)} className={`nav-link ${pathname === href ? "nav-link-active" : ""}`}>
              <Icon size={18} /> {label}
            </Link>
          ))}
        </nav>
        <div className="mt-10 rounded-lg border border-slate-200 bg-white p-4 shadow-sm lg:absolute lg:bottom-6 lg:left-6 lg:right-6">
          <p className="truncate text-sm font-semibold text-slate-950">{user?.name || "User"}</p>
          <p className="truncate text-xs text-slate-500">{user?.email}</p>
          <button onClick={logout} className="btn-secondary mt-4 flex w-full items-center justify-center gap-2"><LogOut size={16} /> Logout</button>
        </div>
    </>
  );

  return (
    <div className="min-h-screen bg-slate-50">
      <header className="sticky top-0 z-30 flex items-center justify-between border-b border-slate-200 bg-white/90 px-4 py-3 shadow-sm backdrop-blur lg:hidden">
        <div className="text-lg font-black tracking-tight text-slate-950">LoanConnect<span className="text-sky-600">AI</span></div>
        <button onClick={() => setMenuOpen(true)} className="rounded-lg border border-slate-200 bg-white p-2 text-slate-700" aria-label="Open menu">
          <Menu size={20} />
        </button>
      </header>
      <aside className="fixed inset-y-0 left-0 hidden w-72 border-r border-slate-200 bg-white/95 p-6 shadow-xl shadow-slate-200/60 lg:block">
        {sidebar}
      </aside>
      {menuOpen && (
        <div className="fixed inset-0 z-40 bg-slate-950/40 lg:hidden">
          <aside className="h-full w-[min(20rem,85vw)] border-r border-slate-200 bg-white p-6 shadow-2xl">
            {sidebar}
          </aside>
        </div>
      )}
      <main className="min-h-screen p-4 sm:p-6 lg:ml-72 lg:p-8">{children}</main>
    </div>
  );
}
