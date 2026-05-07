"use client";

/**
 * Port of assistant-ui Grok example — tokens map to Basics palette (primary green, semantic bg/border/muted).
 * @see https://github.com/assistant-ui/assistant-ui/blob/main/apps/docs/components/examples/grok.tsx
 */

import Image from "next/image";

import {
  ActionBarPrimitive,
  AttachmentPrimitive,
  AuiIf,
  ComposerPrimitive,
  MessagePrimitive,
  ThreadPrimitive,
  useAuiState,
  useMessageTiming,
} from "@assistant-ui/react";
import {
  ArrowUp,
  Copy,
  Loader2,
  Mic,
  Paperclip,
  Pencil,
  RotateCw,
  Square,
  ThumbsDown,
  ThumbsUp,
  X,
} from "@/icons";
import { useEffect, useState, type FC } from "react";
import { useShallow } from "zustand/react/shallow";

import { MarkdownText } from "@/components/assistant-ui/markdown-text";
import { cn } from "@/lib/utils";

export function BasicsThread() {
  return (
    <ThreadPrimitive.Root
      className={cn(
        "flex h-[calc(100vh-12rem)] min-h-[520px] flex-col items-stretch rounded-xl border bg-card px-4",
      )}
    >
      <AuiIf condition={(s) => s.thread.isEmpty}>
        <div className="flex h-full flex-col items-center justify-center">
          <Image
            src="/basics-logo.png"
            alt=""
            width={40}
            height={40}
            className="mb-6 size-10 rounded-xl"
            priority
          />
          <Composer />
        </div>
      </AuiIf>

      <AuiIf condition={(s) => !s.thread.isEmpty}>
        <ThreadPrimitive.Viewport className="flex min-h-0 flex-1 grow flex-col overflow-y-auto pt-16">
          <ThreadPrimitive.Messages>{() => <ChatMessage />}</ThreadPrimitive.Messages>
        </ThreadPrimitive.Viewport>
        <Composer />
        <p className="mx-auto w-full max-w-3xl pb-2 text-center text-muted-foreground text-xs">
          Basics can make mistakes. Verify important information.
        </p>
      </AuiIf>
    </ThreadPrimitive.Root>
  );
}

const Composer: FC = () => {
  const isEmpty = useAuiState((s) => s.composer.isEmpty);
  const isRunning = useAuiState((s) => s.thread.isRunning);

  return (
    <ComposerPrimitive.Root
      className="group/composer mx-auto mb-3 w-full max-w-3xl"
      data-empty={isEmpty}
      data-running={isRunning}
    >
      <div
        className={cn(
          "overflow-hidden rounded-4xl bg-muted/60 shadow-xs ring-1 ring-border ring-inset transition-shadow",
          "focus-within:ring-primary/35",
        )}
      >
        <AuiIf condition={(s) => s.composer.attachments.length > 0}>
          <div className="flex flex-row flex-wrap gap-2 px-4 pt-3">
            <ComposerPrimitive.Attachments>{() => <GrokAttachment />}</ComposerPrimitive.Attachments>
          </div>
        </AuiIf>

        <div className="flex items-end gap-1 p-2">
          <ComposerPrimitive.AddAttachment
            className={cn(
              "mb-0.5 flex h-9 w-9 shrink-0 items-center justify-center rounded-full text-foreground transition-colors",
              "hover:bg-muted",
            )}
          >
            <Paperclip className="size-[18px]" />
          </ComposerPrimitive.AddAttachment>

          <ComposerPrimitive.Input
            placeholder="What do you want to know?"
            minRows={1}
            className={cn(
              "my-2 h-6 max-h-100 min-w-0 flex-1 resize-none bg-transparent text-base leading-6 outline-none",
              "text-foreground placeholder:text-muted-foreground",
            )}
          />

          <div className="relative mb-0.5 h-9 w-9 shrink-0 rounded-full bg-primary text-primary-foreground">
            <button
              type="button"
              className={cn(
                "absolute inset-0 flex items-center justify-center transition-all duration-300 ease-out",
                "group-data-[empty=false]/composer:scale-0 group-data-[running=true]/composer:scale-0",
                "group-data-[empty=false]/composer:opacity-0 group-data-[running=true]/composer:opacity-0",
              )}
              aria-label="Voice mode"
            >
              <Mic className="size-[18px]" />
            </button>

            <ComposerPrimitive.Send
              className={cn(
                "absolute inset-0 flex items-center justify-center transition-all duration-300 ease-out",
                "group-data-[empty=true]/composer:scale-0 group-data-[running=true]/composer:scale-0",
                "group-data-[empty=true]/composer:opacity-0 group-data-[running=true]/composer:opacity-0",
              )}
            >
              <ArrowUp className="size-[18px]" />
            </ComposerPrimitive.Send>

            <ComposerPrimitive.Cancel
              className={cn(
                "absolute inset-0 flex items-center justify-center transition-all duration-300 ease-out",
                "group-data-[running=false]/composer:scale-0 group-data-[running=false]/composer:opacity-0",
              )}
            >
              <Square className="size-3.5 fill-current" />
            </ComposerPrimitive.Cancel>
          </div>
        </div>
      </div>
    </ComposerPrimitive.Root>
  );
};

const ChatMessage: FC = () => {
  return (
    <MessagePrimitive.Root className="group/message relative mx-auto mb-2 flex w-full max-w-3xl flex-col pb-0.5">
      <AuiIf condition={(s) => s.message.role === "user"}>
        <div className="flex flex-col items-end">
          <div
            className={cn(
              "relative max-w-[90%] rounded-3xl rounded-br-lg border border-border bg-muted/90 px-4 py-3 text-foreground",
            )}
          >
            <div className="wrap-break-word [&_.aui-md]:space-y-0">
              <MessagePrimitive.Parts>
                {({ part }) => {
                  if (part.type === "text") return <MarkdownText className="space-y-0 text-sm" />;
                  return null;
                }}
              </MessagePrimitive.Parts>
            </div>
          </div>
          <div className="mt-1 flex h-8 items-center justify-end gap-0.5 opacity-0 transition-opacity group-focus-within/message:opacity-100 group-hover/message:opacity-100">
            <ActionBarPrimitive.Root className="flex items-center gap-0.5">
              <ActionBarPrimitive.Edit
                className={cn(
                  "flex h-8 w-8 items-center justify-center rounded-full text-muted-foreground transition-colors",
                  "hover:bg-muted hover:text-foreground",
                )}
              >
                <Pencil className="size-4" />
              </ActionBarPrimitive.Edit>
              <ActionBarPrimitive.Copy
                className={cn(
                  "flex h-8 w-8 items-center justify-center rounded-full text-muted-foreground transition-colors",
                  "hover:bg-muted hover:text-foreground",
                )}
              >
                <Copy className="size-4" />
              </ActionBarPrimitive.Copy>
            </ActionBarPrimitive.Root>
          </div>
        </div>
      </AuiIf>

      <AuiIf condition={(s) => s.message.role === "assistant"}>
        <div className="flex flex-col items-start">
          <div className="w-full max-w-none">
            <div className="wrap-break-word text-foreground">
              <MessagePrimitive.Parts>
                {({ part }) => {
                  if (part.type !== "text") return null;
                  if (part.text === "" && part.status?.type === "running") {
                    return (
                      <span className="inline-flex items-center gap-2 text-muted-foreground text-sm">
                        <Loader2 className="size-3.5 animate-spin" />
                        Thinking…
                      </span>
                    );
                  }
                  return <MarkdownText className="text-sm" />;
                }}
              </MessagePrimitive.Parts>
            </div>
          </div>
          <div className="mt-1 flex h-8 w-full items-center justify-start gap-0.5 opacity-0 transition-opacity group-focus-within/message:opacity-100 group-hover/message:opacity-100">
            <ActionBarPrimitive.Root className="-ml-2 flex items-center gap-0.5">
              <ActionBarPrimitive.Reload
                className={cn(
                  "flex h-8 w-8 items-center justify-center rounded-full text-muted-foreground transition-colors",
                  "hover:bg-muted hover:text-foreground",
                )}
              >
                <RotateCw className="size-4" />
              </ActionBarPrimitive.Reload>
              <ActionBarPrimitive.Copy
                className={cn(
                  "flex h-8 w-8 items-center justify-center rounded-full text-muted-foreground transition-colors",
                  "hover:bg-muted hover:text-foreground",
                )}
              >
                <Copy className="size-4" />
              </ActionBarPrimitive.Copy>
              <ActionBarPrimitive.FeedbackPositive
                className={cn(
                  "flex h-8 w-8 items-center justify-center rounded-full text-muted-foreground transition-colors",
                  "hover:bg-muted hover:text-foreground",
                )}
              >
                <ThumbsUp className="size-4" />
              </ActionBarPrimitive.FeedbackPositive>
              <ActionBarPrimitive.FeedbackNegative
                className={cn(
                  "flex h-8 w-8 items-center justify-center rounded-full text-muted-foreground transition-colors",
                  "hover:bg-muted hover:text-foreground",
                )}
              >
                <ThumbsDown className="size-4" />
              </ActionBarPrimitive.FeedbackNegative>
              <MessageTimingDisplay />
            </ActionBarPrimitive.Root>
          </div>
        </div>
      </AuiIf>
    </MessagePrimitive.Root>
  );
};

const formatTime = (ms: number | undefined) => {
  if (ms === undefined) return null;
  if (ms < 1000) return `${Math.round(ms)}ms`;
  return `${(ms / 1000).toFixed(1)}s`;
};

const formatMs = (ms: number | undefined) => {
  if (ms === undefined) return "\u2014";
  if (ms < 1000) return `${Math.round(ms)}ms`;
  return `${(ms / 1000).toFixed(2)}s`;
};

const MessageTimingDisplay: FC = () => {
  const timing = useMessageTiming();
  if (!timing?.totalStreamTime) return null;

  const totalTimeText = formatTime(timing.totalStreamTime);
  if (!totalTimeText) return null;

  return (
    <div className="group/timing relative">
      <button
        type="button"
        className={cn(
          "ml-1 flex h-auto items-center justify-center rounded-md px-1.5 py-0.5 font-mono text-muted-foreground text-xs tabular-nums transition-colors",
          "hover:bg-muted hover:text-foreground",
        )}
      >
        {totalTimeText}
      </button>
      <div
        className={cn(
          "pointer-events-none absolute top-1/2 left-full z-10 ml-2 -translate-y-1/2 scale-95 rounded-lg border border-border bg-popover px-3 py-2 text-popover-foreground opacity-0 shadow-lg transition-all",
          "before:absolute before:top-0 before:-left-2 before:h-full before:w-2 before:content-['']",
          "group-hover/timing:pointer-events-auto group-hover/timing:scale-100 group-hover/timing:opacity-100",
        )}
      >
        <div className="grid min-w-[140px] gap-1.5 text-xs">
          {timing.firstTokenTime !== undefined && (
            <div className="flex items-center justify-between gap-4">
              <span className="text-muted-foreground">First token</span>
              <span className="font-mono tabular-nums">{formatMs(timing.firstTokenTime)}</span>
            </div>
          )}
          <div className="flex items-center justify-between gap-4">
            <span className="text-muted-foreground">Total</span>
            <span className="font-mono tabular-nums">{formatMs(timing.totalStreamTime)}</span>
          </div>
          {timing.tokensPerSecond !== undefined && (
            <div className="flex items-center justify-between gap-4">
              <span className="text-muted-foreground">Speed</span>
              <span className="font-mono tabular-nums">{timing.tokensPerSecond.toFixed(1)} tok/s</span>
            </div>
          )}
          {timing.totalChunks > 0 && (
            <div className="flex items-center justify-between gap-4">
              <span className="text-muted-foreground">Chunks</span>
              <span className="font-mono tabular-nums">{timing.totalChunks}</span>
            </div>
          )}
        </div>
      </div>
    </div>
  );
};

const useAttachmentSrc = () => {
  const { file, src } = useAuiState(
    useShallow((s): { file?: File; src?: string } => {
      if (s.attachment.type !== "image") return {};
      if (s.attachment.file) return { file: s.attachment.file };
      const imageSrc = s.attachment.content?.filter((c) => c.type === "image")[0]?.image;
      if (!imageSrc) return {};
      return { src: imageSrc };
    }),
  );

  const [fileSrc, setFileSrc] = useState<string | undefined>(undefined);

  useEffect(() => {
    if (!file) {
      setFileSrc(undefined);
      return;
    }
    const objectUrl = URL.createObjectURL(file);
    setFileSrc(objectUrl);
    return () => URL.revokeObjectURL(objectUrl);
  }, [file]);

  return fileSrc ?? src;
};

const GrokAttachment: FC = () => {
  const src = useAttachmentSrc();

  return (
    <AttachmentPrimitive.Root className="group/attachment relative">
      <div
        className={cn(
          "flex h-12 items-center gap-2 overflow-hidden rounded-xl border border-border bg-muted p-0.5 transition-colors",
          "hover:border-primary/25",
        )}
      >
        <AuiIf condition={(s) => s.attachment.type === "image"}>
          {src ? (
            // eslint-disable-next-line @next/next/no-img-element -- blob/object URLs from picker
            <img className="h-full w-12 rounded-[9px] object-cover" alt="Attachment" src={src} />
          ) : (
            <div className="flex h-full w-12 items-center justify-center rounded-[9px] bg-muted text-muted-foreground">
              <AttachmentPrimitive.unstable_Thumb className="text-xs" />
            </div>
          )}
        </AuiIf>
        <AuiIf condition={(s) => s.attachment.type !== "image"}>
          <div className="flex h-full w-12 items-center justify-center rounded-[9px] bg-muted text-muted-foreground">
            <AttachmentPrimitive.unstable_Thumb className="text-xs" />
          </div>
        </AuiIf>
      </div>
      <AttachmentPrimitive.Remove
        className={cn(
          "absolute -top-1.5 -right-1.5 flex h-6 w-6 scale-50 items-center justify-center rounded-full border border-border bg-card text-muted-foreground opacity-0 transition-all",
          "hover:bg-muted hover:text-foreground",
          "group-hover/attachment:scale-100 group-hover/attachment:opacity-100",
        )}
      >
        <X className="size-3.5" />
      </AttachmentPrimitive.Remove>
    </AttachmentPrimitive.Root>
  );
};
