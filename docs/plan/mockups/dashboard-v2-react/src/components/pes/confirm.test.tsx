import { useState } from "react";
import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { MemoryRouter } from "react-router";
import { ConfirmDialog, type ConfirmSpec } from "@/components/pes/confirm";
import { installDomStubs } from "@/test/render-app";

/** UI7-2 동작 보존 — ConfirmDialog 열 때 이유 칸 초기화 · 본인 확인 단계 */

const base: ConfirmSpec = {
  title: "시험 변경",
  changes: ["바뀌는 것 하나"],
  unchanged: ["그대로인 것 하나"],
  target: "시험 대상 rev 1",
  verb: "시험 실행",
  stepUp: false,
};

function Harness({ spec, onConfirm = () => {} }: { spec: ConfirmSpec; onConfirm?: (r: string, s: unknown) => void }) {
  const [open, setOpen] = useState(false);
  return (
    <MemoryRouter>
      <button onClick={() => setOpen(true)}>열기</button>
      <ConfirmDialog open={open} onOpenChange={setOpen} spec={spec} phase="idle" receipt={null} onConfirm={onConfirm} />
    </MemoryRouter>
  );
}

const reasonInput = () => screen.getByLabelText(/이유/) as HTMLInputElement;

describe("ConfirmDialog — 열 때마다 처음 모양", () => {
  it("열면 이유 칸이 기본값으로 채워지고 첫 입력에 초점이 간다", () => {
    installDomStubs();
    render(<Harness spec={{ ...base, reasonDefault: "기본 이유" }} />);
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
    fireEvent.click(screen.getByText("열기"));
    expect(reasonInput().value).toBe("기본 이유");
    expect(reasonInput()).toHaveFocus();
  });

  it("적은 이유는 닫았다 다시 열면 기본값으로 돌아간다", () => {
    installDomStubs();
    render(<Harness spec={{ ...base, reasonDefault: "기본 이유" }} />);
    fireEvent.click(screen.getByText("열기"));
    fireEvent.change(reasonInput(), { target: { value: "내가 적은 이유" } });
    expect(reasonInput().value).toBe("내가 적은 이유");
    fireEvent.click(screen.getByRole("button", { name: "취소" }));
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
    fireEvent.click(screen.getByText("열기"));
    expect(reasonInput().value).toBe("기본 이유");
  });

  it("기본값이 없으면 빈 칸으로 다시 열린다", () => {
    installDomStubs();
    render(<Harness spec={base} />);
    fireEvent.click(screen.getByText("열기"));
    fireEvent.change(reasonInput(), { target: { value: "지워질 말" } });
    fireEvent.click(screen.getByRole("button", { name: "취소" }));
    fireEvent.click(screen.getByText("열기"));
    expect(reasonInput().value).toBe("");
  });

  it("본인 확인이 없는 요청은 동사 단추가 이유를 담아 바로 보낸다", () => {
    installDomStubs();
    const onConfirm = vi.fn();
    render(<Harness spec={base} onConfirm={onConfirm} />);
    fireEvent.click(screen.getByText("열기"));
    fireEvent.change(reasonInput(), { target: { value: "사유" } });
    fireEvent.click(screen.getByRole("button", { name: "시험 실행" }));
    expect(onConfirm).toHaveBeenCalledWith("사유", undefined);
  });

  it("이유가 필수인데 비어 있으면 보내지 않고 안내와 초점을 준다", () => {
    installDomStubs();
    const onConfirm = vi.fn();
    render(<Harness spec={{ ...base, reasonRequired: true, stepUp: true }} onConfirm={onConfirm} />);
    fireEvent.click(screen.getByText("열기"));
    fireEvent.click(screen.getByRole("button", { name: /시험 실행/ }));
    expect(onConfirm).not.toHaveBeenCalled();
    expect(screen.getByText("다시 켜는 동작은 이유를 적어야 합니다.")).toBeInTheDocument();
    expect(screen.queryByText("본인 확인이 필요합니다")).not.toBeInTheDocument();
  });
});

describe("ConfirmDialog — 본인 확인 단계", () => {
  const stepUpSpec: ConfirmSpec = { ...base, stepUp: true };

  it("동사 단추를 누르면 본인 확인 단계로 가고, 이전 단계로 누르면 돌아온다", () => {
    installDomStubs();
    render(<Harness spec={stepUpSpec} />);
    fireEvent.click(screen.getByText("열기"));
    fireEvent.click(screen.getByRole("button", { name: "시험 실행 — 본인 확인으로" }));
    expect(screen.getByText("본인 확인이 필요합니다")).toBeInTheDocument();
    expect(screen.queryByText("바뀌는 것")).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "이전 단계로" }));
    expect(screen.getByText("바뀌는 것")).toBeInTheDocument();
    expect(screen.queryByText("본인 확인이 필요합니다")).not.toBeInTheDocument();
  });

  it("본인 확인 방법을 고르면 이유와 방법·대상이 함께 나간다", () => {
    installDomStubs();
    const onConfirm = vi.fn();
    render(<Harness spec={stepUpSpec} onConfirm={onConfirm} />);
    fireEvent.click(screen.getByText("열기"));
    fireEvent.change(reasonInput(), { target: { value: "사유" } });
    fireEvent.click(screen.getByRole("button", { name: "시험 실행 — 본인 확인으로" }));
    fireEvent.click(screen.getByRole("button", { name: "이 컴퓨터에서 소유자로 확인" }));
    expect(onConfirm).toHaveBeenCalledWith("사유", { method: "local_owner", bound: "시험 대상 rev 1" });
  });

  it("본인 확인 단계에서 닫았다 다시 열면 처음 단계(이유 칸)로 열린다", () => {
    installDomStubs();
    render(<Harness spec={{ ...stepUpSpec, reasonDefault: "기본" }} />);
    fireEvent.click(screen.getByText("열기"));
    fireEvent.click(screen.getByRole("button", { name: "시험 실행 — 본인 확인으로" }));
    expect(screen.getByText("본인 확인이 필요합니다")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "취소" }));
    fireEvent.click(screen.getByText("열기"));
    expect(screen.queryByText("본인 확인이 필요합니다")).not.toBeInTheDocument();
    expect(reasonInput().value).toBe("기본");
  });
});
