// SEL-120 REF1c — 붙이기 대화 상자가 서버(GET P/reference-candidates) 후보를 그린다. 합성 값만.
// 나머지 클라이언트 메서드는 시험용 가짜(sel114), 후보 읽기만 실제 http 클라이언트 + 가짜 fetch.
import { cleanup, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createHttpClient } from "@/api/http-client";
import { WORKSPACE } from "@/api/fixture";
import { FORMAT_VERSION } from "@/api/types";
import { boot, createReferencesClient, waitRows } from "@/test/sel114";

afterEach(cleanup);

const ID = "pj-synthetic-3";
const body = {
  format_version: FORMAT_VERSION,
  request_id: "req-1",
  data: {
    candidates: [
      { project_id: "pj-x", key: "pj-x", label: "합성 서버 주제 X", attached: false, snapshots: [{ id: "sn-xb", key: "sn-xb", label: null, approved: true, recommended: true }, { id: "sn-xa", key: "sn-xa", label: null, approved: false, recommended: false }] },
      { project_id: "pj-y", key: "pj-y", label: "합성 서버 주제 Y", attached: true, snapshots: [{ id: "sn-ya", key: "sn-ya", label: null, approved: true, recommended: true }] },
    ],
  },
};

describe("붙이기 대화 상자 — 서버 후보", () => {
  it("http 클라이언트가 읽은 후보를 그린다: 프로젝트 이름 · 이미 붙임 · 스냅숏은 이름이 없어 key 로 · 승인 안 됨 · 추천", async () => {
    const urls: string[] = [];
    const fetchImpl = vi.fn(async (input: RequestInfo | URL) => {
      urls.push(new URL(String(input), "http://app.invalid").pathname);
      return new Response(JSON.stringify(body), { status: 200 });
    }) as unknown as typeof fetch;
    const http = createHttpClient({ session: "synthetic-session-ref1c", projects: { [WORKSPACE.slug]: ID }, fetch: fetchImpl });
    const rc = createReferencesClient();
    const client = Object.assign(Object.create(rc.client), rc.client, { getReferenceCandidates: http.getReferenceCandidates.bind(http) });
    const user = userEvent.setup();
    await boot({ ...rc, client });
    await waitRows();
    await user.click(screen.getByRole("button", { name: "참고 프로젝트 붙이기" }));
    const dlg = await screen.findByRole("dialog", { name: "참고 프로젝트 붙이기" });

    const x = await within(dlg).findByRole("radio", { name: /합성 서버 주제 X/ });
    expect((x as HTMLInputElement).disabled).toBe(false);
    const y = within(dlg).getByRole("radio", { name: /합성 서버 주제 Y/ }) as HTMLInputElement;
    expect(y.disabled).toBe(true);
    expect(y.closest("label")?.textContent).toContain("이미 붙임");
    expect(urls).toContain(`/api/v1/projects/${ID}/reference-candidates`);

    await user.click(x);
    const group = await within(dlg).findByRole("radiogroup", { name: "고정할 버전" });
    const best = within(group).getByRole("radio", { name: /sn-xb/ }) as HTMLInputElement;
    expect(best.checked).toBe(true);
    expect(best.closest("label")?.textContent).toContain("추천");
    expect(within(group).getByRole("radio", { name: /sn-xa/ }).closest("label")?.textContent).toContain("승인 안 됨");
    expect(group.textContent).not.toContain("null");
  });

  // 이유: 서버 404 는 '대상 프로젝트 없음'이라 후보 0건으로 그리면 안 된다(SEL-120 F2 필수 1). 읽기 실패 경고만 보여야 한다.
  it("후보 읽기 404 → 읽기 실패 경고, '붙일 수 있는 프로젝트가 없어요' 가 아니다", async () => {
    const notFound = { format_version: FORMAT_VERSION, request_id: "req-e", error: { code: "not_found", message: "합성 거절 문장", retryable: false, target: "$.project", details: null, next_action: "reread_context" } };
    const fetchImpl = vi.fn(async () => new Response(JSON.stringify(notFound), { status: 404 })) as unknown as typeof fetch;
    const http = createHttpClient({ session: "synthetic-session-ref1c", projects: { [WORKSPACE.slug]: ID }, fetch: fetchImpl });
    const rc = createReferencesClient();
    const client = Object.assign(Object.create(rc.client), rc.client, { getReferenceCandidates: http.getReferenceCandidates.bind(http) });
    const user = userEvent.setup();
    await boot({ ...rc, client });
    await waitRows();
    await user.click(screen.getByRole("button", { name: "참고 프로젝트 붙이기" }));
    const dlg = await screen.findByRole("dialog", { name: "참고 프로젝트 붙이기" });
    const alert = await within(dlg).findByRole("alert");
    expect(alert.textContent).toContain("프로젝트 목록을 읽지 못했어요");
    expect(dlg.textContent).not.toContain("붙일 수 있는 프로젝트가 없어요");
  });
});
