"use client";

import remarkGfm from "remark-gfm";

import { MarkdownTextPrimitive } from "@assistant-ui/react-markdown";
import { cn } from "@/lib/utils";

export function MarkdownText({ className }: { className?: string }) {
  return (
    <MarkdownTextPrimitive
      remarkPlugins={[remarkGfm]}
      className={cn(
        "aui-md max-w-none space-y-3 text-foreground text-sm leading-relaxed",
        "[&_a]:font-medium [&_a]:text-primary [&_a]:underline-offset-2 hover:[&_a]:underline",
        "[&_blockquote]:border-l-4 [&_blockquote]:border-primary/25 [&_blockquote]:pl-3 [&_blockquote]:text-muted-foreground",
        "[&_code]:rounded-md [&_code]:bg-muted [&_code]:px-1 [&_code]:py-0.5 [&_code]:font-mono [&_code]:text-xs",
        "[&_pre]:overflow-x-auto [&_pre]:rounded-lg [&_pre]:border [&_pre]:border-border [&_pre]:bg-muted [&_pre]:p-3 [&_pre]:font-mono [&_pre]:text-xs",
        "[&_ul]:list-disc [&_ul]:pl-5 [&_ol]:list-decimal [&_ol]:pl-5",
        "[&_table]:w-full [&_table]:border-collapse [&_th]:border [&_th]:border-border [&_th]:bg-muted/50 [&_th]:px-2 [&_th]:py-1 [&_th]:text-left [&_th]:text-xs [&_td]:border [&_td]:border-border [&_td]:px-2 [&_td]:py-1 [&_td]:text-xs",
        "[&_h1]:font-semibold [&_h1]:text-lg [&_h2]:font-semibold [&_h2]:text-base [&_strong]:font-semibold",
        className,
      )}
    />
  );
}
