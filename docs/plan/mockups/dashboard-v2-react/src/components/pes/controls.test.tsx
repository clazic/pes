import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { ActionButton, StateSwitch } from "@/components/pes/controls";
import { installDomStubs } from "@/test/render-app";

/** UI7-2 동작 보존 — controls: 막힌 단추·스위치를 누르면 이유가 그 자리에 보이고, 막힘이 풀리면 다시 숨는다 */

const REASON = "소유자만 바꿀 수 있습니다.";

describe("ActionButton", () => {
  it("막히지 않으면 누를 때 onClick이 불린다", () => {
    const onClick = vi.fn();
    render(<ActionButton onClick={onClick}>바꾸기</ActionButton>);
    fireEvent.click(screen.getByRole("button", { name: "바꾸기" }));
    expect(onClick).toHaveBeenCalledTimes(1);
  });

  it("막히면 aria-disabled · 이유는 화면 읽기에만(sr-only) · 눌러도 onClick은 안 불린다", () => {
    const onClick = vi.fn();
    render(<ActionButton blockedBy={REASON} onClick={onClick}>바꾸기</ActionButton>);
    const btn = screen.getByRole("button", { name: "바꾸기" });
    expect(btn).toHaveAttribute("aria-disabled", "true");
    const why = screen.getByText(REASON);
    expect(why).toHaveClass("sr-only");
    expect(why).not.toHaveAttribute("data-reason");
    expect(btn.getAttribute("aria-describedby")).toBe(why.id);
    fireEvent.click(btn);
    expect(onClick).not.toHaveBeenCalled();
  });

  it("막힌 단추를 누르면 이유가 그 자리에 보인다", () => {
    render(<ActionButton blockedBy={REASON}>바꾸기</ActionButton>);
    fireEvent.click(screen.getByRole("button", { name: "바꾸기" }));
    const why = screen.getByText(REASON);
    expect(why).toHaveAttribute("data-reason");
    expect(why).not.toHaveClass("sr-only");
  });

  it("showReason이면 누르기 전부터 이유가 보인다", () => {
    render(<ActionButton blockedBy={REASON} showReason>바꾸기</ActionButton>);
    expect(screen.getByText(REASON)).toHaveAttribute("data-reason");
  });

  it("막힘이 풀렸다가 다시 막히면 이유는 다시 숨은 채로 시작한다", () => {
    const { rerender } = render(<ActionButton blockedBy={REASON}>바꾸기</ActionButton>);
    fireEvent.click(screen.getByRole("button", { name: "바꾸기" }));
    expect(screen.getByText(REASON)).toHaveAttribute("data-reason");
    rerender(<ActionButton blockedBy={null}>바꾸기</ActionButton>);
    expect(screen.queryByText(REASON)).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: "바꾸기" })).not.toHaveAttribute("aria-disabled");
    rerender(<ActionButton blockedBy={REASON}>바꾸기</ActionButton>);
    const why = screen.getByText(REASON);
    expect(why).toHaveClass("sr-only");
    expect(why).not.toHaveAttribute("data-reason");
  });

  it("이유 문장이 따로 있으면(reasonId) 이유를 또 그리지 않고 그 id로 연결한다", () => {
    render(
      <>
        <p id="outer-why">밖의 이유</p>
        <ActionButton blockedBy={REASON} reasonId="outer-why">바꾸기</ActionButton>
      </>,
    );
    expect(screen.queryByText(REASON)).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: "바꾸기" }).getAttribute("aria-describedby")).toContain("outer-why");
  });
});

describe("StateSwitch — 요청 흐름", () => {
  const props = { onLabel: "허용", offLabel: "막음", name: "AI가 읽기" };

  it("켜진 스위치를 누르면 바꾸지 않고 부모에게 끄기(false)를 요청한다", () => {
    installDomStubs();
    const onRequest = vi.fn();
    render(<StateSwitch {...props} checked onRequest={onRequest} />);
    const sw = screen.getByRole("switch", { name: "AI가 읽기" });
    expect(sw).toHaveAttribute("aria-checked", "true");
    expect(screen.getByText("허용")).toBeInTheDocument();
    fireEvent.click(sw);
    expect(onRequest).toHaveBeenCalledWith(false);
    // 부모가 확인하기 전에는 스스로 바뀌지 않는다
    expect(sw).toHaveAttribute("aria-checked", "true");
  });

  it("꺼진 스위치를 누르면 켜기(true)를 요청한다", () => {
    installDomStubs();
    const onRequest = vi.fn();
    render(<StateSwitch {...props} checked={false} onRequest={onRequest} />);
    expect(screen.getByText("막음")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("switch", { name: "AI가 읽기" }));
    expect(onRequest).toHaveBeenCalledWith(true);
  });

  it("바꾸는 중이면 글자가 “바꾸는 중”이고 요청하지 않는다", () => {
    installDomStubs();
    const onRequest = vi.fn();
    render(<StateSwitch {...props} checked pending onRequest={onRequest} />);
    expect(screen.getByText("바꾸는 중")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("switch", { name: "AI가 읽기" }));
    expect(onRequest).not.toHaveBeenCalled();
  });

  it("막힌 스위치는 요청하지 않고, 누르면 이유가 보이며, 막힘이 풀렸다 다시 막히면 다시 숨는다", () => {
    installDomStubs();
    const onRequest = vi.fn();
    const { rerender } = render(<StateSwitch {...props} checked blockedBy={REASON} onRequest={onRequest} />);
    const why0 = screen.getByText(REASON);
    expect(why0).toHaveClass("sr-only");
    fireEvent.click(screen.getByRole("switch", { name: "AI가 읽기" }));
    expect(onRequest).not.toHaveBeenCalled();
    expect(screen.getByText(REASON)).toHaveAttribute("data-reason");
    rerender(<StateSwitch {...props} checked blockedBy={null} onRequest={onRequest} />);
    expect(screen.queryByText(REASON)).not.toBeInTheDocument();
    rerender(<StateSwitch {...props} checked blockedBy={REASON} onRequest={onRequest} />);
    expect(screen.getByText(REASON)).not.toHaveAttribute("data-reason");
    expect(screen.getByText(REASON)).toHaveClass("sr-only");
  });
});
