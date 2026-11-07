import { computeAccess, DEST_LABEL, DESTS, type PolicyCase } from "@/api/policy";
import { Table, TableBody, TableCaption, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { StatusFrom } from "@/components/pes/status";

const REF_CASE: PolicyCase = {
  id: "ref",
  label: "이 참고자료",
  api: "on",
  file: "allow",
  ref: { sourceApi: "off", sourceFile: "allow", sourceAllows: ["Claude Code"], tool: "Claude Code" },
};

/** 이 참고자료가 AI에 가는 방식 — 원본 정책과 이 프로젝트 정책 중 엄격한 쪽을 서버가 목적지별로 계산(Codex F02) */
export function ReferenceTable() {
  return (
    <Table regionLabel="참고자료가 AI에 가는 방식">
      <TableCaption>이 참고자료가 AI에 가는 방식 · 원본과 이 프로젝트 중 엄격한 쪽</TableCaption>
      <TableHeader>
        <TableRow>
          <TableHead scope="col">어디로</TableHead>
          <TableHead scope="col">결과</TableHead>
          <TableHead scope="col">이유</TableHead>
        </TableRow>
      </TableHeader>
      <TableBody>
        {DESTS.map((d) => {
          const r = computeAccess(d, REF_CASE);
          return (
            <TableRow key={d}>
              <TableHead scope="row">{DEST_LABEL[d]}</TableHead>
              <TableCell>
                <StatusFrom s={r.status} wrap />
              </TableCell>
              <TableCell>{r.reason}</TableCell>
            </TableRow>
          );
        })}
      </TableBody>
    </Table>
  );
}
