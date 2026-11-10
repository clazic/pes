import { act, fireEvent, render, screen } from "@testing-library/react";
import { beforeEach, describe, expect, it } from "vitest";
import { clearDraft, draftKey, readDraftNow, useDraft } from "@/lib/draft";

/** UI7-2 동작 보존 — useDraft(초안 읽기 · 쓰기 · 탭 바뀜). 경고를 없애도 아래 동작은 그대로여야 한다 */

const K1 = draftKey("demo", 1, "q1", 1);
const K2 = draftKey("demo", 1, "q2", 1);

function Probe({ k, label = "a" }: { k: string; label?: string }) {
  const [draft, setDraft] = useDraft(k);
  return (
    <div>
      <output aria-label={`${label}-초안`}>{draft ? JSON.stringify(draft) : "없음"}</output>
      <button onClick={() => setDraft({ option: "o1" })}>{label}-옵션</button>
      <button onClick={() => setDraft({ comment: "의견" })}>{label}-의견</button>
      <button onClick={() => setDraft({ option: "", comment: "", other: undefined })}>{label}-비우기</button>
      <button onClick={() => setDraft(null)}>{label}-지우기</button>
    </div>
  );
}

beforeEach(() => sessionStorage.clear());

describe("useDraft", () => {
  it("저장된 초안을 처음 그릴 때 바로 읽는다", () => {
    sessionStorage.setItem(K1, JSON.stringify({ option: "o2" }));
    render(<Probe k={K1} />);
    expect(screen.getByLabelText("a-초안")).toHaveTextContent('{"option":"o2"}');
  });

  it("초안이 없으면 없음이다", () => {
    render(<Probe k={K1} />);
    expect(screen.getByLabelText("a-초안")).toHaveTextContent("없음");
  });

  it("쓰면 화면과 sessionStorage에 남고, 앞 초안과 합쳐진다", () => {
    render(<Probe k={K1} />);
    fireEvent.click(screen.getByText("a-옵션"));
    fireEvent.click(screen.getByText("a-의견"));
    expect(JSON.parse(sessionStorage.getItem(K1)!)).toEqual({ option: "o1", comment: "의견" });
    expect(screen.getByLabelText("a-초안")).toHaveTextContent('{"option":"o1","comment":"의견"}');
    expect(readDraftNow(K1)).toEqual({ option: "o1", comment: "의견" });
  });

  it("모든 칸이 비면 저장소에서 지우고 화면도 없음이 된다", () => {
    render(<Probe k={K1} />);
    fireEvent.click(screen.getByText("a-옵션"));
    fireEvent.click(screen.getByText("a-비우기"));
    expect(sessionStorage.getItem(K1)).toBeNull();
    expect(screen.getByLabelText("a-초안")).toHaveTextContent("없음");
  });

  it("null로 지우면 없음이다", () => {
    render(<Probe k={K1} />);
    fireEvent.click(screen.getByText("a-옵션"));
    fireEvent.click(screen.getByText("a-지우기"));
    expect(sessionStorage.getItem(K1)).toBeNull();
    expect(screen.getByLabelText("a-초안")).toHaveTextContent("없음");
  });

  it("키가 바뀌면(다른 질문) 그 키의 초안으로 바뀐다", () => {
    sessionStorage.setItem(K1, JSON.stringify({ option: "o1" }));
    sessionStorage.setItem(K2, JSON.stringify({ comment: "둘째" }));
    const { rerender } = render(<Probe k={K1} />);
    expect(screen.getByLabelText("a-초안")).toHaveTextContent('{"option":"o1"}');
    rerender(<Probe k={K2} />);
    expect(screen.getByLabelText("a-초안")).toHaveTextContent('{"comment":"둘째"}');
    // 초안이 없는 키로 가면 없음
    rerender(<Probe k={draftKey("demo", 1, "q3", 1)} />);
    expect(screen.getByLabelText("a-초안")).toHaveTextContent("없음");
    // 다시 돌아오면 저장돼 있던 초안이 보인다
    rerender(<Probe k={K1} />);
    expect(screen.getByLabelText("a-초안")).toHaveTextContent('{"option":"o1"}');
  });

  it("같은 키를 쓰는 다른 화면은 쓰기·지우기를 따라 바뀐다", () => {
    render(
      <>
        <Probe k={K1} label="a" />
        <Probe k={K1} label="b" />
      </>,
    );
    fireEvent.click(screen.getByText("a-옵션"));
    expect(screen.getByLabelText("b-초안")).toHaveTextContent('{"option":"o1"}');
    act(() => clearDraft(K1));
    expect(screen.getByLabelText("a-초안")).toHaveTextContent("없음");
    expect(screen.getByLabelText("b-초안")).toHaveTextContent("없음");
  });

  it("다른 키의 쓰기는 이 화면을 바꾸지 않는다", () => {
    render(
      <>
        <Probe k={K1} label="a" />
        <Probe k={K2} label="b" />
      </>,
    );
    fireEvent.click(screen.getByText("b-옵션"));
    expect(screen.getByLabelText("a-초안")).toHaveTextContent("없음");
  });

  it("키에 폼 버전이 들어가 옛 버전 초안이 새 버전으로 가지 않는다", () => {
    sessionStorage.setItem(draftKey("demo", 1, "q1", 1), JSON.stringify({ option: "옛것" }));
    render(<Probe k={draftKey("demo", 2, "q1", 1)} />);
    expect(screen.getByLabelText("a-초안")).toHaveTextContent("없음");
  });
});
