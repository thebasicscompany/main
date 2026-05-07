"use client";

import type { ReactNode } from "react";
import { useEffect, useState } from "react";

import { Lenis } from "lenis/react";

const LENIS_OPTIONS = {
  autoRaf: true,
  overscroll: true,
} as const;

export function AppMainScroll({ children }: { children: ReactNode }) {
  const [useLenis, setUseLenis] = useState(false);

  useEffect(() => {
    const mq = window.matchMedia("(prefers-reduced-motion: reduce)");
    const apply = () => setUseLenis(!mq.matches);
    apply();
    mq.addEventListener("change", apply);
    return () => mq.removeEventListener("change", apply);
  }, []);

  const shellClass = "min-h-0 flex-1 overflow-x-hidden overscroll-y-contain";

  if (!useLenis) {
    return (
      <div data-app-scroll="main" className={`${shellClass} overflow-y-auto p-4 md:p-6`}>
        {children}
      </div>
    );
  }

  return (
    <Lenis data-app-scroll="main" className={shellClass} options={LENIS_OPTIONS}>
      <div className="p-4 md:p-6">{children}</div>
    </Lenis>
  );
}
