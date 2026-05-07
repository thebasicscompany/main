import * as React from "react";

import { cn } from "@/lib/utils";

function OrbitRing({ className, style, ...props }: React.ComponentProps<"span">) {
  return (
    <span
      role="status"
      className={cn("relative inline-block size-4 shrink-0", className)}
      style={{
        animation: "loading-ui-orbit-ring-rotation var(--duration, 1s) linear infinite",
        ...style,
      }}
      {...props}
    >
      <span aria-hidden="true" className="absolute inset-0 rounded-full border-2 border-current" style={{ opacity: 0.25 }} />
      <span
        aria-hidden="true"
        className="absolute top-1/2 left-1/2 rounded-full border-2 border-transparent border-b-current"
        style={{
          width: "116.667%",
          height: "116.667%",
          transform: "translate(-50%, -50%)",
        }}
      />
      <span className="sr-only">Loading</span>
    </span>
  );
}

export { OrbitRing };
