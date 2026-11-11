import { screen, waitFor } from "@testing-library/react";
import { expect } from "vitest";

/** 화면 제목까지 그려진 뒤 */
export const ready = async () => {
  await screen.findByRole("main");
  await waitFor(() => expect(screen.getByRole("main").querySelector("[data-screen-title]")).not.toBeNull());
};

/** 질문 영역의 답 / 의견 칸 (textbox 이름에 "답" / "의견"; 요소 id 는 질문 id 와 `-opinion`) */
export const answerBox = (qid: string) => document.getElementById(qid) as HTMLTextAreaElement;
export const opinionBox = (qid: string) => document.getElementById(`${qid}-opinion`) as HTMLTextAreaElement;
export const askPane = () => screen.getByRole("complementary", { name: "질문" });

/** 이 탭 sessionStorage 항목 중 키가 패턴에 맞는 것 */
export const draftEntries = (pattern: RegExp) => Object.entries({ ...window.sessionStorage }).filter(([k]) => pattern.test(k));
