import { ReactNode, useEffect, useMemo, useState } from "react";
import { Link, Navigate, NavLink, Route, Routes, useLocation } from "react-router-dom";
import {
  detectCapabilities,
  initCapabilities,
  meetsMinRequirements,
} from "./local/capabilities";
import { HelpOverlay } from "./editor/components/HelpOverlay";
import { RecMark } from "./editor/components/RuleStrip";
import { Footer } from "./components/Footer";
import { Datenschutz } from "./pages/Datenschutz";
import Arrange from "./pages/Arrange";
import Editor from "./pages/Editor";
import { JobPermissionRoute } from "./components/JobPermissionRoute";
import History from "./pages/History";
import Reel from "./pages/Reel";
import { Impressum } from "./pages/Impressum";
import JobPage from "./pages/JobPage";
import RenderScreen from "./pages/RenderScreen";
import { Settings } from "./pages/Settings";
import { BrowserTooOld } from "./pages/BrowserTooOld";
import Triage from "./pages/Triage";
import Upload from "./pages/Upload";
import ConfirmDialogHost from "./components/ConfirmDialogHost";

export default function App() {
  const location = useLocation();
  // Hide the global TopBar on routes that own their full-bleed layout
  // (the editor and the render screen).
  const isFullBleed =
    /^\/job\/[^/]+\/edit/.test(location.pathname) ||
    /^\/job\/[^/]+\/render$/.test(location.pathname) ||
    /^\/job\/[^/]+\/triage$/.test(location.pathname) ||
    /^\/job\/[^/]+\/arrange$/.test(location.pathname) ||
    /^\/reel(\/|$)/.test(location.pathname);
  // `caps` starts with the sync probe (webgpu=false) and gets the
  // async-probed `webgpu` merged in once `initCapabilities()` resolves.
  // Both Settings (display) and any render-backend consumer that reads
  // via `getCapabilities()` see the merged result.
  const [caps, setCaps] = useState(() => detectCapabilities());
  const min = useMemo(() => meetsMinRequirements(caps), [caps]);

  // Hold off rendering anything browser-API-dependent until we've confirmed
  // we're not running in jsdom-with-coercion (some unit tests stub
  // navigator etc.). For real browsers this is a one-tick check.
  // We also await the WebGPU adapter probe so the Render-Backend factory
  // gets a reliable `caps.webgpu` from the very first mount.
  const [ready, setReady] = useState(false);
  useEffect(() => {
    let cancelled = false;
    initCapabilities()
      .then((merged) => {
        if (!cancelled) setCaps(merged);
      })
      .catch(() => undefined)
      .finally(() => {
        if (!cancelled) setReady(true);
      });
    return () => {
      cancelled = true;
    };
  }, []);
  if (!ready) {
    return <main className="min-h-full" aria-hidden />;
  }

  if (!min.ok) {
    return (
      <>
        <BrowserTooOld missing={min.missing} />
        <HelpOverlay />
      </>
    );
  }

  return (
    <div className="min-h-full flex flex-col paper-bg">
      {!isFullBleed && <TopBar />}
      <Routes>
        <Route path="/" element={<Upload />} />
        <Route path="/jobs" element={<History />} />
        <Route path="/job/:id" element={<JobPermissionRoute><JobPage /></JobPermissionRoute>} />
        <Route path="/job/:id/triage" element={<JobPermissionRoute><Triage /></JobPermissionRoute>} />
        <Route path="/job/:id/arrange" element={<JobPermissionRoute><Arrange /></JobPermissionRoute>} />
        <Route path="/job/:id/edit" element={<JobPermissionRoute><Editor /></JobPermissionRoute>} />
        <Route path="/job/:id/render" element={<JobPermissionRoute><RenderScreen /></JobPermissionRoute>} />
        <Route path="/reel/:id" element={<Reel />} />
        <Route path="/settings" element={<Settings caps={caps} />} />
        <Route path="/impressum" element={<Impressum />} />
        <Route path="/datenschutz" element={<Datenschutz />} />
        <Route path="*" element={<Navigate to="/" replace />} />
      </Routes>
      <Footer overlay={isFullBleed} />
      <HelpOverlay />
      <ConfirmDialogHost />
    </div>
  );
}

function TopBar() {
  return (
    <header className="border-b border-rule bg-paper-hi shadow-panel">
      <div className="max-w-7xl mx-auto px-3 sm:px-6 h-14 flex items-center justify-between gap-2 sm:gap-4">
        <Link to="/" className="flex items-center gap-2 sm:gap-2.5 group min-w-0 shrink">
          <RecMark className="text-ink shrink-0" />
          <div className="leading-none min-w-0">
            <span className="font-display tracking-label uppercase text-[11px] text-ink-2 block">
              TK-1
            </span>
            <span className="font-display text-[13px] sm:text-[15px] font-semibold text-ink leading-none block truncate">
              Take One
            </span>
          </div>
        </Link>
        <nav className="flex items-center gap-0.5 sm:gap-1 shrink-0">
          <NavTab to="/" end>
            New
          </NavTab>
          <NavTab to="/jobs">Library</NavTab>
          <NavTab to="/settings">Settings</NavTab>
        </nav>
      </div>
    </header>
  );
}

function NavTab({
  to,
  end,
  children,
}: {
  to: string;
  end?: boolean;
  children: ReactNode;
}) {
  return (
    <NavLink
      to={to}
      end={end}
      className={({ isActive }) =>
        [
          "h-9 px-2 sm:px-3 inline-flex items-center font-display tracking-label uppercase text-[11px] rounded-md",
          isActive ? "bg-ink text-paper-hi" : "text-ink-2 hover:text-ink",
        ].join(" ")
      }
    >
      {children}
    </NavLink>
  );
}
