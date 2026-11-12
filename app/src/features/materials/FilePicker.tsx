import * as React from "react";
import { UploadIcon } from "lucide-react";
import { cn } from "@/lib/utils";

/**
 * 파일 고르기 입력 — 진짜 input[type=file] 을 화면 읽기·키보드가 닿게 두고(tabindex 그대로), 겉모양은 같은 칸의 label 이 맡는다.
 * 같은 파일을 다시 골라도 변화가 일어나게 고른 뒤 value 를 비운다. 끌어 놓은 파일도 같은 길로 보낸다.
 */
export function FilePicker({ label, onPick, multiple = true, compact = false, className, hint }: { label: React.ReactNode; onPick: (files: File[]) => void; multiple?: boolean; compact?: boolean; className?: string; hint?: React.ReactNode }) {
  const [over, setOver] = React.useState(false);
  const id = React.useId();
  return (
    <div
      data-dropzone=""
      onDragOver={(e) => {
        e.preventDefault();
        setOver(true);
      }}
      onDragLeave={() => setOver(false)}
      onDrop={(e) => {
        e.preventDefault();
        setOver(false);
        const files = [...e.dataTransfer.files];
        if (files.length) onPick(multiple ? files : files.slice(0, 1));
      }}
      className={cn(
        compact ? "inline-flex" : "flex flex-col items-start gap-1 rounded-md border border-dashed border-control bg-surface px-4 py-4",
        over && "border-primary bg-primary-soft",
        className,
      )}
    >
      <label
        htmlFor={id}
        className={cn(
          "relative inline-flex min-h-9 cursor-pointer items-center gap-1.5 rounded-lg border border-border bg-background px-3.5 py-1.5 text-sm font-medium text-foreground shadow-xs transition-colors hover:bg-accent hover:text-accent-foreground has-[:focus-visible]:outline-2 has-[:focus-visible]:outline-solid has-[:focus-visible]:outline-offset-2 has-[:focus-visible]:outline-ring",
          compact && "min-h-8 px-2.5 py-1 text-meta",
        )}
      >
        <UploadIcon aria-hidden="true" className="size-4 shrink-0" />
        {label}
        <input
          id={id}
          type="file"
          multiple={multiple}
          className="sr-only"
          onChange={(e) => {
            const input = e.currentTarget;
            const files = [...(input.files ?? [])];
            input.value = "";
            if (files.length) onPick(files);
          }}
        />
      </label>
      {hint ? <p className="text-caption text-ink-2">{hint}</p> : null}
    </div>
  );
}
