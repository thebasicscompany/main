"use client";

import React, { useMemo, type ElementType, type JSX } from "react";
import { motion, useReducedMotion } from "motion/react";

import { cn } from "@/lib/utils";

export type TextShimmerProps = {
  children: string;
  as?: ElementType;
  className?: string;
  duration?: number;
  spread?: number;
  baseColor?: string;
  shimmerColor?: string;
  style?: React.CSSProperties;
};

function TextShimmerComponent({
  children,
  as: Component = "p",
  className,
  duration = 2,
  spread = 2,
  baseColor,
  shimmerColor,
  style,
}: TextShimmerProps) {
  const reducedMotion = useReducedMotion();

  const MotionComponent = useMemo(
    () => motion.create(Component as keyof JSX.IntrinsicElements),
    [Component],
  );

  const dynamicSpread = useMemo(() => children.length * spread, [children, spread]);

  const shimmerStyle = {
    ...style,
    "--spread": `${dynamicSpread}px`,
    "--base-color": baseColor ?? "color-mix(in oklab, currentColor 55%, transparent)",
    "--base-gradient-color": shimmerColor ?? "currentColor",
    backgroundImage: `var(--bg), linear-gradient(var(--base-color), var(--base-color))`,
  } as React.CSSProperties;

  const shimmerClassName = cn(
    "relative inline-block bg-size-[250%_100%,auto] bg-clip-text font-medium [-webkit-text-fill-color:transparent]",
    "[background-repeat:no-repeat,padding-box] [--bg:linear-gradient(90deg,#0000_calc(50%-var(--spread)),var(--base-gradient-color),#0000_calc(50%+var(--spread)))]",
    className,
  );

  if (reducedMotion) {
    return (
      <Component className={cn("relative inline-block font-medium", className)} style={style}>
        {children}
      </Component>
    );
  }

  return (
    <MotionComponent
      className={shimmerClassName}
      initial={{ backgroundPosition: "100% center" }}
      animate={{ backgroundPosition: "0% center" }}
      transition={{
        repeat: Infinity,
        duration,
        ease: "linear",
      }}
      style={shimmerStyle}
    >
      {children}
    </MotionComponent>
  );
}

export const TextShimmer = React.memo(TextShimmerComponent);
