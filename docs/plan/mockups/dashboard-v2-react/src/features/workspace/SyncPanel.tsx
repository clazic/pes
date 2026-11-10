import * as React from "react";
import { Link } from "react-router";
import { useCommand } from "@/api/queries";
import type { WorkspaceView } from "@/api/types";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { RadioGroup, RadioGroupItem } from "@/components/ui/radio-group";
import { Table, TableBody, TableCaption, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { Anno, CardHead } from "@/components/pes/bits";
import { Callout } from "@/components/pes/blocks";
import { ActionButton } from "@/components/pes/controls";
import { Chip, StatusFrom } from "@/components/pes/status";
import { useMockSettings } from "@/lib/mock-settings";
import { cn } from "@/lib/utils";

const CHOICES = [
  { v: "pc", title: "내 컴퓨터 것을 새 버전(v4)으로 올리기", hint: "웹 v3은 버전 기록에 남습니다." },
  { v: "web", title: "웹 v3을 내 컴퓨터로 받기", hint: "내 컴퓨터 것은 “충돌 사본”으로 이름을 바꿔 둡니다." },
  { v: "later", title: "둘 다 두고 나중에 정하기", hint: "이 파일은 정할 때까지 동기화하지 않습니다." },
] as const;

function ConflictDialog({ ws, open, onOpenChange }: { ws: WorkspaceView; open: boolean; onOpenChange: (o: boolean) => void }) {
  const [choice, setChoice] = React.useState<"pc" | "web" | "later" | "">("");
  const [why, setWhy] = React.useState("");
  const cmd = useCommand("sync.conflict.resolve");
  const c = ws.conflict!;
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>{c.item} — 양쪽에서 바뀌었습니다</DialogTitle>
          <DialogDescription>어느 쪽을 쓸까요? 어느 쪽도 지우지 않습니다. 고르는 일은 사람만 합니다(데스크톱 권장).</DialogDescription>
        </DialogHeader>
        <div className="grid grid-cols-1 gap-2 tab:grid-cols-2">
          <div className="rounded-lg border border-line bg-surface-soft px-2.5 py-2 text-caption">
            <strong>내 컴퓨터</strong>
            {c.pc.map((l) => (
              <span key={l} className="block font-mono">
                {l}
              </span>
            ))}
          </div>
          <div className="rounded-lg border border-line bg-surface-soft px-2.5 py-2 text-caption">
            <strong>웹 PES</strong>
            {c.web.map((l) => (
              <span key={l} className="block font-mono">
                {l}
              </span>
            ))}
          </div>
        </div>
        <fieldset>
          <legend className="mb-1.5 text-meta font-semibold">고르기</legend>
          <RadioGroup value={choice} onValueChange={(v) => setChoice(v as typeof choice)} className="gap-1.5" aria-label="충돌 처리 방법">
            {CHOICES.map((o) => (
              <label key={o.v} htmlFor={`cf-${o.v}`} className={cn("flex cursor-pointer items-start gap-2 rounded-lg border px-2.5 py-2", choice === o.v ? "border-primary bg-primary-soft" : "border-line")}>
                <RadioGroupItem id={`cf-${o.v}`} value={o.v} className="mt-1" />
                <span>
                  <strong className="text-meta">{o.title}</strong>
                  <span className="block text-caption text-muted-foreground">{o.hint}</span>
                </span>
              </label>
            ))}
          </RadioGroup>
        </fieldset>
        <div>
          <Label htmlFor="cf-why" className="text-meta font-semibold">
            이유 <span className="font-normal text-muted-foreground">(선택)</span>
          </Label>
          <Input id="cf-why" className="mt-1" placeholder="예: 박검토가 고친 일정이 최신" value={why} onChange={(e) => setWhy(e.target.value)} />
        </div>
        {cmd.phase === "done" ? (
          <Callout tone="ok" role="status">
            <Chip shape="circle" tone="ok">
              정함
            </Chip>{" "}
            접수 번호 {cmd.receipt?.receipt_no}
          </Callout>
        ) : null}
        <DialogFooter>
          <Button onClick={() => onOpenChange(false)}>{cmd.phase === "done" ? "닫기" : "취소"}</Button>
          {cmd.phase !== "done" ? (
            <ActionButton variant="default" blockedBy={!choice ? "어느 쪽을 쓸지 골라 주세요." : cmd.pending ? "접수 확인 중입니다" : null} onClick={() => choice && cmd.run({ slug: ws.slug, item: c.item, choice, reason: why })}>
              이대로 정하기
            </ActionButton>
          ) : null}
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

/** 동기화(설계 4.11): 내 컴퓨터와 웹 사이 · 사람이 붙인 폴더 이름만 · 삭제 비전파 · 충돌은 사람이 고름 */
export function SyncPanel({ ws }: { ws: WorkspaceView }) {
  const [open, setOpen] = React.useState(false);
  const settings = useMockSettings();
  const pause = useCommand("sync.pause", { successText: (r) => `동기화 일시 중지 · 접수 번호 ${r.receipt_no} — 다시 시작은 데스크톱에서` });
  if (!ws.sync) return null;
  const resolveWhy = settings.role !== "owner" ? "충돌 고르기는 소유자만(편집자 허용은 WEB3에서 정함 — 지금은 기본 거부)." : null;
  return (
    <div className="mt-4">
      <Card id="sync" size="compact" aria-labelledby="sync-title">
        <CardHead
          eyebrow={`동기화 · ${ws.sync.device} · ${ws.sync.folder_label}`}
          title={ws.sync.summary}
          titleId="sync-title"
          right={
            <>
              <Button size="sm" onClick={() => pause.run({ slug: ws.slug })}>
                동기화 일시 중지
              </Button>
              <Button size="sm" asChild>
                <Link to="/computer">내 컴퓨터 연결 관리</Link>
              </Button>
            </>
          }
        />
        <Table regionLabel="동기화 항목" className="min-w-[640px]">
          <TableCaption>최근 항목</TableCaption>
          <TableHeader>
            <TableRow>
              <TableHead scope="col">항목</TableHead>
              <TableHead scope="col">방향</TableHead>
              <TableHead scope="col">상태</TableHead>
              <TableHead scope="col">버전</TableHead>
              <TableHead scope="col">동작</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {ws.sync.rows.map((r) => (
              <TableRow key={r.id}>
                <TableCell>{r.item}</TableCell>
                <TableCell>{r.direction === "up" ? "올림 · PC→웹" : "받음 · 웹→PC"}</TableCell>
                <TableCell>
                  <StatusFrom s={r.status} wrap />
                </TableCell>
                <TableCell>{r.version}</TableCell>
                <TableCell>
                  {r.action === "resolve" ? (
                    <ActionButton size="sm" blockedBy={resolveWhy} onClick={() => setOpen(true)}>
                      고르기
                    </ActionButton>
                  ) : r.action === "open_web" ? (
                    <Button variant="link" asChild>
                      <Link to={`/p/${ws.slug}/files#f4`}>웹에서 열기</Link>
                    </Button>
                  ) : (
                    "—"
                  )}
                </TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
        <Anno>삭제는 건너가지 않고 표시만 합니다. 내 컴퓨터 폴더의 실제 경로는 웹에 보내지 않고, 사람이 붙인 폴더 이름만 보입니다. 큰 파일은 웹소켓이 아니라 HTTP로 올리고 받습니다. AI 참조 금지 파일은 내 컴퓨터로 자동으로 내려보내지 않습니다(사람이 웹에서 열거나 직접 받음).</Anno>
        {ws.conflict ? <ConflictDialog ws={ws} open={open} onOpenChange={setOpen} /> : null}
      </Card>
    </div>
  );
}
