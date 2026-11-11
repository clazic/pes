import { createCn } from "cn/config"

/**
 * 글자 크기 5단계(index.css의 --text-caption · meta · body · title · page)를 “글자 크기”로 알려 준다.
 * 알려 주지 않으면 cn이 text-meta 같은 이름을 글자 색으로 보고 단추의 글자색(text-primary-foreground)을 지운다.
 */
export const cn = createCn({
  extend: { classGroups: { "font-size": [{ text: ["caption", "meta", "body", "title", "page"] }] } },
})
