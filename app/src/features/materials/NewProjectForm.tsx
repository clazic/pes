import * as React from "react";
import { useQueryClient } from "@tanstack/react-query";
import { useNavigate } from "react-router";
import { rememberProject } from "@/api/handoff-exchange";
import { keys, newIdempotencyKey, useClient } from "@/api/queries";
import { NotConnectedError, PesApiError } from "@/api/types";
import { Button } from "@/components/ui/button";

/** 서버 SLUG 모양과 같다 — 영어 소문자·숫자·하이픈, 첫 글자는 영어·숫자, 64자까지 */
const SLUG = /^[a-z0-9][a-z0-9-]{0,63}$/;
const OWNER = "로컬 소유자";

const fieldClass =
  "mt-1 block w-full rounded-md border border-control bg-background px-2.5 py-2 text-body text-ink shadow-xs outline-none focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring aria-invalid:border-bad";

/** 이름(slug)을 비우면 주제의 영어·숫자만 따고 뒤에 무작위 다섯 글자를 붙인다(한글만이면 project) */
function autoSlug(topic: string): string {
  const base = topic
    .normalize("NFKD")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 40)
    .replace(/-+$/, "");
  const tail = Array.from({ length: 5 }, () => Math.floor(Math.random() * 36).toString(36)).join("");
  return `${base || "project"}-${tail}`;
}

type Field = "topic" | "slug" | null;
interface Problem {
  text: string;
  field: Field;
}

/** 거절·실패 → 한국어 한 줄과 초점 자리. 키를 버릴지(다음 시도가 새 요청인지)도 알려 준다 */
function explain(error: unknown): Problem & { keepKey: boolean } {
  if (error instanceof NotConnectedError) return { text: "이 화면에서는 프로젝트를 만들 수 없습니다 — 터미널에서 pes list 로 여세요", field: null, keepKey: true };
  if (error instanceof PesApiError) {
    const code = error.body.error.code as string;
    if (code === "unauthenticated" || code === "forbidden" || code === "human_required") return { text: "권한이 없습니다 — 터미널에서 pes list 로 다시 여세요", field: null, keepKey: true };
    if (code === "conflict") return { text: "이미 있는 이름입니다 — 다른 이름(slug)으로 바꿔 주세요", field: "slug", keepKey: false };
    if (code === "invalid_payload" || code === "validation_failed") return { text: "입력을 확인해 주세요 — 주제와 이름(slug)을 다시 봐 주세요", field: "topic", keepKey: false };
    if (error.body.error.retryable) return { text: "서버가 바쁩니다 — 잠시 뒤 다시 눌러 주세요 (같은 내용은 두 번 만들어지지 않습니다)", field: null, keepKey: true };
    return { text: "프로젝트를 만들지 못했습니다 — 잠시 뒤 다시 해 보세요", field: null, keepKey: false };
  }
  return { text: "서버에 연결하지 못했습니다 — 서버가 켜져 있는지 보고 다시 눌러 주세요 (같은 내용은 두 번 만들어지지 않습니다)", field: null, keepKey: true };
}

/**
 * 새 프로젝트 만들기(SEL-130) — 첫 페이지의 ‘프로젝트 시작’이 여기로 온다. 주제(필수)와 이름(slug, 선택)을 받아 POST /api/v1/projects 를 한 번 보낸다.
 *  - 같은 내용을 다시 보내면(두 번 누름 · 응답이 늦어 다시 누름 · 연결 오류 뒤 재시도) 같은 멱등 키·같은 이름이라 프로젝트는 하나만 만들어진다. 내용을 바꾸면 새 키.
 *  - 성공하면 그 프로젝트의 현재 위치(기획 단계 시작 자리)로 간다. 요청이 가는 중에 이 화면을 떠났다면 늦게 온 응답은 이동시키지 않는다(프로젝트는 만들어졌다).
 *  - 세션이 없으면(주소로 직접 열었다) 화면은 그리되 만들기는 요청 없이 안내한다.
 */
export function NewProjectForm() {
  const client = useClient();
  const queryClient = useQueryClient();
  const navigate = useNavigate();
  const [topic, setTopic] = React.useState("");
  const [slug, setSlug] = React.useState("");
  const [problem, setProblem] = React.useState<Problem | null>(null);
  const [sending, setSending] = React.useState(false);
  const flight = React.useRef(false);
  const attempt = React.useRef<{ sig: string; key: string; slug: string } | null>(null);
  const here = React.useRef(true);
  React.useEffect(() => {
    here.current = true;
    return () => {
      here.current = false;
    };
  }, []);
  const topicRef = React.useRef<HTMLInputElement>(null);
  const slugRef = React.useRef<HTMLInputElement>(null);
  const buttonRef = React.useRef<HTMLButtonElement>(null);
  const ids = React.useId();
  const alertId = `${ids}-alert`;
  const hintId = `${ids}-hint`;

  const fail = (p: Problem) => {
    setProblem(p);
    (p.field === "topic" ? topicRef : p.field === "slug" ? slugRef : buttonRef).current?.focus();
  };

  async function submit(ev: React.FormEvent) {
    ev.preventDefault();
    if (flight.current) return;
    const subject = topic.trim();
    const typed = slug.trim();
    if (subject === "") return fail({ text: "주제를 적어 주세요 — 어떤 연구인지 한 줄이면 됩니다", field: "topic" });
    if (typed !== "" && !SLUG.test(typed)) return fail({ text: "이름(slug)은 영어 소문자·숫자·하이픈으로 64자까지 적을 수 있습니다", field: "slug" });
    const sig = `${subject}\n${typed}`;
    if (attempt.current === null || attempt.current.sig !== sig) attempt.current = { sig, key: newIdempotencyKey(), slug: typed !== "" ? typed : autoSlug(subject) };
    const { key, slug: name } = attempt.current;
    flight.current = true;
    setSending(true);
    setProblem(null);
    try {
      const made = await client.createProject({ slug: name, topic: subject, owner_display_name: OWNER }, key);
      rememberProject(window, made.slug, made.project_id);
      await queryClient.invalidateQueries({ queryKey: keys.projects });
      if (here.current) navigate(`/p/${encodeURIComponent(made.slug)}`);
    } catch (error) {
      const why = explain(error);
      if (!why.keepKey) attempt.current = null;
      if (here.current) fail(why);
    } finally {
      flight.current = false;
      if (here.current) setSending(false);
    }
  }

  return (
    <form onSubmit={(e) => void submit(e)} noValidate aria-labelledby={`${ids}-title`}>
      <h2 id={`${ids}-title`} className="text-title text-ink">
        프로젝트
      </h2>
      <p className="mt-1 text-meta text-ink-2">주제를 적고 만들면 기획 단계의 시작 화면이 열려요.</p>

      <div className="mt-3">
        <label htmlFor={`${ids}-topic`} className="text-meta font-medium text-ink">
          주제
        </label>
        <input
          ref={topicRef}
          id={`${ids}-topic`}
          type="text"
          value={topic}
          onChange={(e) => setTopic(e.target.value)}
          autoComplete="off"
          required
          aria-required="true"
          aria-invalid={problem?.field === "topic" ? "true" : undefined}
          aria-describedby={problem ? alertId : undefined}
          className={fieldClass}
        />
      </div>

      <div className="mt-3">
        <label htmlFor={`${ids}-slug`} className="text-meta font-medium text-ink">
          이름 (slug, 선택)
        </label>
        <input
          ref={slugRef}
          id={`${ids}-slug`}
          type="text"
          value={slug}
          onChange={(e) => setSlug(e.target.value)}
          autoComplete="off"
          spellCheck={false}
          aria-invalid={problem?.field === "slug" ? "true" : undefined}
          aria-describedby={hintId}
          className={fieldClass}
        />
        <p id={hintId} className="mt-1 text-caption text-ink-2">
          비우면 자동으로 정합니다. 영어 소문자·숫자·하이픈, 64자까지.
        </p>
      </div>

      {problem ? (
        <p id={alertId} role="alert" className="mt-3 text-meta font-medium text-bad">
          {problem.text}
        </p>
      ) : null}

      <div className="mt-4">
        <Button ref={buttonRef} type="submit" variant="default" aria-disabled={sending || undefined}>
          만들기
        </Button>
      </div>
    </form>
  );
}
