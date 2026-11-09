import * as React from "react";
import { FileIcon, FolderIcon, FolderOpenIcon, UploadIcon } from "lucide-react";
import { useCommand } from "@/api/queries";
import type { FileRow, UploadCandidate } from "@/api/types";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Label } from "@/components/ui/label";
import { Progress } from "@/components/ui/progress";
import { ScrollArea } from "@/components/ui/scroll-area";
import { Tag } from "@/components/pes/bits";
import { Callout } from "@/components/pes/blocks";
import { InfoTip } from "@/components/pes/disclosure";
import { StateSwitch } from "@/components/pes/controls";
import { Chip, Status } from "@/components/pes/status";
import { FOLDER_EXAMPLE, UPLOAD_LIMITS } from "@/mocks/materials";
import { cn } from "@/lib/utils";

/**
 * 자료 올리기 — 파일 또는 폴더째(사용자 결정 2026-11-05).
 * 순서: 고르기(파일 · 폴더 · 끌어 놓기) → 올리기 전 미리 보기(폴더 안 상대 경로 · 판정) → 확인 → 진행률 · 일부 실패 → 결과.
 * 시안은 고른 파일의 이름·크기·상대 경로만 브라우저 안에서 읽는다. 아무것도 서버로 보내지 않는다.
 */

type Step = "pick" | "preview" | "progress" | "done";
type ItemState = { state: "reserved" | "uploading" | "hashing" | "ready" | "failed" | "skipped"; percent: number; note?: string };

const HIDDEN = /(^|\/)(\.[^/]+|~\$[^/]*|Thumbs\.db|desktop\.ini)$/i;

function judge(path: string, size: number, existing: FileRow[], seenNames: Set<string>): UploadCandidate {
  const name = path.split("/").pop() ?? path;
  const ext = name.includes(".") ? name.split(".").pop()!.toLowerCase() : "";
  const folder = path.includes("/") ? path.slice(0, path.lastIndexOf("/")) : null;
  if (HIDDEN.test(path)) return { path, size, verdict: "hidden", note: "숨김·임시 파일 — 빼기(바꿀 수 있음)", access: "allow" };
  if (size > UPLOAD_LIMITS.perFileMB * 1_000_000) return { path, size, verdict: "too_large", note: `파일당 ${UPLOAD_LIMITS.perFileMB}MB 초과 — 건너뜀(예시 상한)`, access: "allow" };
  if (!UPLOAD_LIMITS.supported.includes(ext)) return { path, size, verdict: "unsupported", note: "지원 안 되는 형식 — 원본만 보관, 글자 뽑기 없음", access: "allow" };
  if (existing.some((f) => f.name === name && f.folder === folder) || seenNames.has(`${folder}/${name}`)) return { path, size, verdict: "same_name", note: "같은 이름이 이미 있음 → 새 버전으로 올림(옛 버전은 남음)", access: "allow" };
  seenNames.add(`${folder}/${name}`);
  return { path, size, verdict: "ok", access: "allow" };
}

async function readEntry(entry: FileSystemEntry, prefix: string, out: { path: string; size: number }[]) {
  if (entry.isFile) {
    const file = await new Promise<File>((res, rej) => (entry as FileSystemFileEntry).file(res, rej));
    out.push({ path: `${prefix}${entry.name}`, size: file.size });
  } else if (entry.isDirectory) {
    const reader = (entry as FileSystemDirectoryEntry).createReader();
    let batch: FileSystemEntry[] = [];
    do {
      batch = await new Promise<FileSystemEntry[]>((res, rej) => reader.readEntries(res, rej));
      for (const e of batch) await readEntry(e, `${prefix}${entry.name}/`, out);
    } while (batch.length > 0);
  }
}

const mb = (n: number) => (n >= 1_000_000 ? `${(n / 1_000_000).toFixed(1)}MB` : `${Math.max(1, Math.round(n / 1000))}KB`);

function Tree({ items, onToggle }: { items: UploadCandidate[]; onToggle: (path: string, next: "allow" | "deny") => void }) {
  // 폴더별로 묶어 상대 경로를 보인다
  const groups = new Map<string, UploadCandidate[]>();
  for (const it of items) {
    const dir = it.path.includes("/") ? it.path.slice(0, it.path.lastIndexOf("/")) : "(폴더 없음)";
    groups.set(dir, [...(groups.get(dir) ?? []), it]);
  }
  return (
    <ul className="space-y-2 text-meta" aria-label="폴더 안 파일">
      {[...groups.entries()].map(([dir, list]) => (
        <li key={dir}>
          <p className="flex items-center gap-1.5 font-semibold text-ink-2">
            <FolderIcon className="size-4" aria-hidden="true" />
            {dir}/
          </p>
          <ul className="mt-1 ml-5 space-y-1 border-l-2 border-line pl-2.5">
            {list.map((it) => {
              const name = it.path.split("/").pop();
              const skipped = it.verdict === "hidden" || it.verdict === "too_large";
              return (
                <li key={it.path} className="grid grid-cols-1 items-center gap-x-3 gap-y-1 tab:grid-cols-[minmax(0,1fr)_auto_auto]">
                  <span className={cn("flex min-w-0 items-center gap-1.5", skipped && "text-muted-foreground line-through decoration-1")}>
                    <FileIcon className="size-3.5 shrink-0" aria-hidden="true" />
                    <span className="min-w-0 break-all">{name}</span>
                    <span className="shrink-0 text-xs text-muted-foreground">{mb(it.size)}</span>
                  </span>
                  <span>
                    {it.verdict === "ok" ? <Status of="generic" value="available" label="올림" /> : null}
                    {it.verdict === "same_name" ? <Status of="generic" value="new_version" /> : null}
                    {it.verdict === "same_content" ? <Status of="generic" value="same_content" /> : null}
                    {it.verdict === "unsupported" ? <Status of="generic" value="unsupported_fmt" /> : null}
                    {it.verdict === "too_large" ? <Status of="generic" value="too_large" /> : null}
                    {it.verdict === "hidden" ? <Status of="generic" value="hidden" /> : null}
                  </span>
                  <span>
                    {skipped ? (
                      <span className="text-xs text-muted-foreground">올리지 않음</span>
                    ) : (
                      <StateSwitch checked={it.access === "allow"} onLabel="허용" offLabel="금지" name={`AI 참조: ${name}`} onRequest={(next) => onToggle(it.path, next ? "allow" : "deny")} />
                    )}
                  </span>
                  {it.note ? <span className="text-xs text-muted-foreground tab:col-span-3">{it.note}</span> : null}
                </li>
              );
            })}
          </ul>
        </li>
      ))}
    </ul>
  );
}

export function UploadDialog({ open, onOpenChange, slug, existing, startMode, onCollect }: { open: boolean; onOpenChange: (o: boolean) => void; slug: string; existing: FileRow[]; startMode?: "folder" | "files"; /** 새 프로젝트 마법사: 올리지 않고 목록만 담는다(만들기 전에는 서버에 아무것도 저장하지 않음) */ onCollect?: (items: UploadCandidate[], root: string) => void }) {
  const [step, setStep] = React.useState<Step>("pick");
  const [items, setItems] = React.useState<UploadCandidate[]>([]);
  const [root, setRoot] = React.useState<string>("");
  const [excludeHidden, setExcludeHidden] = React.useState(true);
  const [progress, setProgress] = React.useState<Record<string, ItemState>>({});
  const [isExample, setIsExample] = React.useState(false);
  const folderInput = React.useRef<HTMLInputElement>(null);
  const fileInput = React.useRef<HTMLInputElement>(null);
  const upload = useCommand("file_upload", { silent: true });
  const batch = useCommand("upload_batch.create", { silent: true });
  const [dragOver, setDragOver] = React.useState(false);

  React.useEffect(() => {
    // React가 모르는 속성이라 직접 붙인다: 폴더 고르기(input webkitdirectory)
    folderInput.current?.setAttribute("webkitdirectory", "");
    folderInput.current?.setAttribute("directory", "");
  });
  React.useEffect(() => {
    if (open) {
      setStep("pick");
      setItems([]);
      setProgress({});
      setIsExample(false);
    }
  }, [open]);

  const accept = (list: { path: string; size: number }[], rootName: string) => {
    const seen = new Set<string>();
    const judged = list.map((f) => judge(f.path, f.size, existing, seen));
    // 같은 크기·같은 이름 바탕(사본)은 내용이 같을 수 있음 — 실제로는 브라우저가 지문(SHA-256)을 계산해 판정
    setItems(judged);
    setRoot(rootName);
    setStep("preview");
  };

  const onPickFiles = (files: FileList | null, folder: boolean) => {
    if (!files || files.length === 0) return;
    const list = Array.from(files).map((f) => ({ path: (folder && f.webkitRelativePath) || f.name, size: f.size }));
    const rootName = folder ? list[0]!.path.split("/")[0]! : "";
    setIsExample(false);
    accept(list, rootName);
  };

  const onDrop = async (e: React.DragEvent) => {
    e.preventDefault();
    setDragOver(false);
    const out: { path: string; size: number }[] = [];
    const entries = Array.from(e.dataTransfer.items)
      .map((i) => i.webkitGetAsEntry?.())
      .filter((x): x is FileSystemEntry => Boolean(x));
    for (const en of entries) await readEntry(en, "", out);
    if (out.length) {
      setIsExample(false);
      accept(out, entries.find((x) => x.isDirectory)?.name ?? "");
    }
  };

  const useExample = () => {
    setIsExample(true);
    setItems(FOLDER_EXAMPLE.items.map((x) => ({ ...x })));
    setRoot(FOLDER_EXAMPLE.root);
    setStep("preview");
  };

  const effective = items.filter((i) => !(i.verdict === "too_large" || (excludeHidden && i.verdict === "hidden")));
  const skipped = items.length - effective.length;
  const totalSize = effective.reduce((a, b) => a + b.size, 0);
  const folderAllow = effective.every((i) => i.access === "allow");
  const denyCount = effective.filter((i) => i.access === "deny").length;
  const overCount = effective.length > UPLOAD_LIMITS.perBatchCount;

  const setFolderAccess = (a: "allow" | "deny") => setItems((xs) => xs.map((x) => ({ ...x, access: a })));
  const toggleOne = (path: string, a: "allow" | "deny") => setItems((xs) => xs.map((x) => (x.path === path ? { ...x, access: a } : x)));

  const start = async () => {
    setStep("progress");
    batch.run({ slug, root, count: effective.length });
    const init: Record<string, ItemState> = {};
    for (const it of effective) init[it.path] = { state: "reserved", percent: 0 };
    for (const it of items) if (!effective.includes(it)) init[it.path] = { state: "skipped", percent: 0, note: it.verdict === "hidden" ? "숨김 파일" : "너무 큼" };
    setProgress(init);
    for (const it of effective) {
      for (const pct of [20, 55, 85, 100]) {
        await new Promise((r) => window.setTimeout(r, 120));
        setProgress((p) => ({ ...p, [it.path]: { state: pct < 100 ? "uploading" : "hashing", percent: pct } }));
      }
      const failThis = isExample && it.path.endsWith("면담 기록 B군(가상).hwpx");
      const folder = it.path.includes("/") ? it.path.slice(0, it.path.lastIndexOf("/")) : null;
      try {
        await upload.runAsync({ slug, path: it.path, size: it.size, access: it.access, folder, simulateFail: failThis });
        setProgress((p) => ({ ...p, [it.path]: { state: "ready", percent: 100, note: it.verdict === "same_name" ? "새 버전으로 올림" : it.verdict === "same_content" ? "내용이 같음 — 새 버전으로 기록" : undefined } }));
      } catch (e) {
        setProgress((p) => ({ ...p, [it.path]: { state: "failed", percent: 0, note: e instanceof Error ? e.message : "올리지 못함" } }));
      }
    }
    setStep("done");
  };

  const retryFailed = async () => {
    const failed = Object.entries(progress).filter(([, v]) => v.state === "failed").map(([k]) => k);
    for (const path of failed) {
      const it = items.find((x) => x.path === path)!;
      const folder = path.includes("/") ? path.slice(0, path.lastIndexOf("/")) : null;
      setProgress((p) => ({ ...p, [path]: { state: "uploading", percent: 50 } }));
      try {
        await upload.runAsync({ slug, path, size: it.size, access: it.access, folder });
        setProgress((p) => ({ ...p, [path]: { state: "ready", percent: 100, note: "다시 올림 — 같은 이름이라 새 버전" } }));
      } catch (e) {
        setProgress((p) => ({ ...p, [path]: { state: "failed", percent: 0, note: e instanceof Error ? e.message : "올리지 못함" } }));
      }
    }
  };

  const states = Object.values(progress);
  const done = states.filter((s) => s.state === "ready").length;
  const failedN = states.filter((s) => s.state === "failed").length;
  const overall = effective.length ? Math.round((states.filter((s) => s.state === "ready" || s.state === "failed").length / effective.length) * 100) : 0;

  return (
    <Dialog open={open} onOpenChange={(o) => step !== "progress" && onOpenChange(o)}>
      <DialogContent className="sm:max-w-3xl">
        <DialogHeader>
          <DialogTitle>자료 올리기 — 파일 또는 폴더째</DialogTitle>
          <DialogDescription>
            {step === "pick" ? "파일을 고르거나 폴더를 통째로 고르거나 끌어 놓으세요. 고른 파일은 이 브라우저 밖으로 나가지 않습니다(시안은 이름·크기만 읽음)." : null}
            {step === "preview" ? `올리기 전 확인 · ${root ? `폴더 “${root}”` : "고른 파일"} · 아직 아무것도 올리지 않았습니다.` : null}
            {step === "progress" ? "올리는 중 — 파일마다 예약 → 올리기 → 지문 확인 → 준비됨. 이 창을 닫아도 표에서 이어 봅니다." : null}
            {step === "done" ? "끝남 — 실패한 파일만 다시 올릴 수 있습니다." : null}
          </DialogDescription>
        </DialogHeader>

        {step === "pick" ? (
          <div
            onDragOver={(e) => {
              e.preventDefault();
              setDragOver(true);
            }}
            onDragLeave={() => setDragOver(false)}
            onDrop={onDrop}
            className={cn("flex flex-col items-center gap-3 rounded-xl border-2 border-dashed p-5 text-center", dragOver ? "border-primary bg-primary-soft" : "border-control bg-surface-soft")}
          >
            <p className="font-semibold">파일이나 폴더를 여기에 끌어 놓거나</p>
            <div className="flex flex-wrap justify-center gap-2">
              <Button variant={startMode === "files" ? "default" : "outline"} onClick={() => fileInput.current?.click()}>
                <UploadIcon aria-hidden="true" />
                파일 고르기
              </Button>
              <Button variant={startMode === "folder" ? "default" : "outline"} onClick={() => folderInput.current?.click()}>
                <FolderOpenIcon aria-hidden="true" />
                폴더 고르기
              </Button>
              <Button variant="link" onClick={useExample}>
                예시 폴더로 보기(합성)
              </Button>
            </div>
            <input ref={fileInput} type="file" multiple className="sr-only" aria-label="파일 고르기" tabIndex={-1} onChange={(e) => onPickFiles(e.target.files, false)} />
            <input ref={folderInput} type="file" multiple className="sr-only" aria-label="폴더 고르기" tabIndex={-1} onChange={(e) => onPickFiles(e.target.files, true)} />
            <div className="flex flex-wrap justify-center gap-1" aria-label="받는 형식">
              {UPLOAD_LIMITS.supported.map((f) => (
                <Tag key={f}>{f}</Tag>
              ))}
            </div>
            <p className="flex flex-wrap items-center justify-center gap-1 text-caption text-muted-foreground">
              상한: 파일당 {UPLOAD_LIMITS.perFileMB}MB · 한 번에 {UPLOAD_LIMITS.perBatchCount}개 · 총 {UPLOAD_LIMITS.perBatchTotalGB}GB(예시값)
              <InfoTip label="올리기 상한 설명">
                <p>상한은 예시값이며 사용자 결정이 필요합니다. 폴더 안 상대 경로는 보존하고, 내 컴퓨터의 실제 경로는 보내지 않습니다.</p>
              </InfoTip>
            </p>
          </div>
        ) : null}

        {step === "preview" ? (
          <>
            <div className="grid grid-cols-2 gap-2 tab:grid-cols-4">
              <Callout tone="info">
                <strong className="block text-lg">{effective.length}개</strong>올릴 파일
              </Callout>
              <Callout tone="info">
                <strong className="block text-lg">{mb(totalSize)}</strong>총 크기
              </Callout>
              <Callout tone={items.some((i) => i.verdict === "unsupported") ? "warn" : "info"}>
                <strong className="block text-lg">{items.filter((i) => i.verdict === "unsupported").length}개</strong>지원 안 되는 형식(원본만)
              </Callout>
              <Callout tone={skipped ? "warn" : "info"}>
                <strong className="block text-lg">{skipped}개</strong>건너뜀(너무 큼·숨김)
              </Callout>
            </div>
            <div className="flex flex-wrap items-center justify-between gap-3 rounded-lg border border-line bg-surface-soft px-3 py-2">
              <div className="flex items-center gap-2 text-meta">
                <Checkbox id="up-hidden" checked={excludeHidden} onCheckedChange={(c) => setExcludeHidden(c === true)} />
                <Label htmlFor="up-hidden" className="font-medium">
                  숨김·임시 파일 빼기 <span className="font-normal text-muted-foreground">(.DS_Store · ~$… · Thumbs.db)</span>
                </Label>
              </div>
              <div className="flex flex-wrap items-center gap-2 text-meta">
                <span className="font-semibold">이 폴더 전체 AI 참조</span>
                <StateSwitch checked={folderAllow} onLabel="허용" offLabel={denyCount === effective.length ? "금지" : `일부 금지 ${denyCount}`} name="이 폴더 전체 AI 참조" onRequest={(next) => setFolderAccess(next ? "allow" : "deny")} />
              </div>
            </div>
            {overCount ? (
              <Callout tone="bad">
                한 번에 {UPLOAD_LIMITS.perBatchCount}개를 넘습니다. 폴더를 나눠 올려 주세요.
              </Callout>
            ) : null}
            <ScrollArea className="max-h-[42vh] rounded-lg border border-line p-3">
              <Tree items={items.map((i) => (excludeHidden || i.verdict !== "hidden" ? i : { ...i, verdict: "ok" as const, note: "숨김 파일 — 포함하기로 함" }))} onToggle={toggleOne} />
            </ScrollArea>
            <p className="flex flex-wrap items-center gap-1 text-caption text-muted-foreground">
              AI 참조는 기본 허용 · 파일마다 바꿀 수 있음 · 같은 이름은 새 버전으로
              <InfoTip label="AI 참조 · 새 버전 설명" wide>
                <p>폴더 스위치로 한꺼번에 바꾸고, 파일마다 다시 바꿀 수 있습니다. “금지”로 올리면 처음부터 금지 정책으로 저장해 허용 구간이 생기지 않게 합니다(준비됨 공개와 처음 정책을 같은 tx — Codex F11). 같은 이름이나 같은 내용은 덮어쓰지 않고 새 버전으로 남깁니다.</p>
              </InfoTip>
            </p>
          </>
        ) : null}

        {step === "progress" || step === "done" ? (
          <>
            <div>
              <div className="mb-1 flex flex-wrap items-center justify-between gap-2 text-meta">
                <span className="font-semibold">
                  {root ? `“${root}” ` : ""}준비됨 {done} · 실패 {failedN} · 건너뜀 {skipped}
                </span>
                <span className="tabular-nums">{overall}%</span>
              </div>
              <Progress value={overall} aria-label={`전체 진행 ${overall}%`} />
            </div>
            <ScrollArea className="max-h-[42vh] rounded-lg border border-line">
              <ul className="divide-y divide-line text-meta">
                {items.map((it) => {
                  const p = progress[it.path];
                  if (!p) return null;
                  return (
                    <li key={it.path} className="grid grid-cols-1 items-center gap-x-3 gap-y-1 px-3 py-2 tab:grid-cols-[minmax(0,1fr)_auto]">
                      <span className="min-w-0 break-all">{it.path}</span>
                      <span>
                        {p.state === "uploading" ? <Status of="upload" value="uploading" label={`올리는 중 ${p.percent}%`} /> : <Status of="upload" value={p.state} />}
                      </span>
                      {p.note ? <span className={cn("text-xs tab:col-span-2", p.state === "failed" ? "font-medium text-bad" : "text-muted-foreground")}>{p.note}</span> : null}
                    </li>
                  );
                })}
              </ul>
            </ScrollArea>
            {step === "done" && failedN ? (
              <Callout tone="warn">
                <Chip shape="tri" tone="warn">
                  일부 실패 {failedN}
                </Chip>{" "}
                나머지는 이미 준비됐습니다. 실패한 파일만 다시 올립니다(같은 이름이라 새 버전으로).
              </Callout>
            ) : null}
          </>
        ) : null}

        <DialogFooter>
          {step === "preview" ? (
            <>
              <Button onClick={() => setStep("pick")}>다시 고르기</Button>
              {onCollect ? (
                <Button
                  variant="default"
                  aria-disabled={overCount || effective.length === 0 || undefined}
                  onClick={() => {
                    if (overCount || !effective.length) return;
                    onCollect(effective, root);
                    onOpenChange(false);
                  }}
                >
                  {effective.length}개 담기 — 아직 올리지 않음
                </Button>
              ) : (
                <Button variant="default" aria-disabled={overCount || effective.length === 0 || undefined} onClick={() => !overCount && effective.length && void start()}>
                  {effective.length}개 올리기
                </Button>
              )}
            </>
          ) : step === "done" ? (
            <>
              {failedN ? <Button onClick={() => void retryFailed()}>실패한 {failedN}개 다시 올리기</Button> : null}
              <Button variant="default" onClick={() => onOpenChange(false)}>
                닫기
              </Button>
            </>
          ) : step === "pick" ? (
            <Button onClick={() => onOpenChange(false)}>취소</Button>
          ) : (
            <span role="status" className="text-meta text-muted-foreground">
              올리는 중…
            </span>
          )}
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
