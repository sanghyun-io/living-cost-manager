#!/usr/bin/env node
// verify-archive.mjs — 이 아카이브 폴더의 무결성 점검 (Node 표준 라이브러리만 사용, 의존성 없음)
// 사용: 아카이브 폴더(docs/design/ui-concepts/2026-10-20)에서 `node verify-archive.mjs`
// 점검: 1) manifest.sha256 해시·바이트 대조  2) HTML 내부 상대 링크/앵커 실존
//       3) HTML 내 외부 요청 가능 토큰(http/https/file://) 부재
// 이 스크립트는 아카이브 검증 전용이며 어떤 앱의 런타임 코드 경로가 아니다.
import { createHash } from 'node:crypto';
import { readFileSync, readdirSync, statSync, existsSync } from 'node:fs';
import { join, dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = dirname(fileURLToPath(import.meta.url));
const failures = [];
const ok = (m) => console.log(`PASS  ${m}`);
const bad = (m) => { failures.push(m); console.log(`FAIL  ${m}`); };

// 1) manifest 해시 대조
const manifest = readFileSync(join(root, 'manifest.sha256'), 'utf8');
let manifestCount = 0;
for (const line of manifest.split('\n')) {
  if (!line.trim() || line.startsWith('#')) continue;
  const m = line.match(/^([0-9a-f]{64})\s+(\d+)\s+(.+)$/);
  if (!m) { bad(`manifest 형식 오류: ${line}`); continue; }
  const [, sha, bytesStr, rel] = m;
  manifestCount++;
  const p = join(root, rel);
  if (!existsSync(p)) { bad(`manifest 파일 없음: ${rel}`); continue; }
  const buf = readFileSync(p);
  const got = createHash('sha256').update(buf).digest('hex');
  if (got !== sha) bad(`해시 불일치: ${rel}`);
  else if (String(buf.length) !== bytesStr) bad(`바이트 수 불일치: ${rel} (manifest ${bytesStr}, 실제 ${buf.length})`);
}
ok(`manifest 항목 ${manifestCount}개 해시·바이트 대조 완료 (오류 ${failures.length}건 시점)`);

// 2)~3) HTML 링크/앵커/외부 토큰
const htmls = readdirSync(root, { recursive: true })
  .map(String)
  .filter((f) => f.endsWith('.html'))
  .sort();
if (htmls.length !== 11) bad(`HTML 파일 수 기대 11, 실제 ${htmls.length}`);
let anchorChecks = 0;
for (const rel of htmls) {
  const dir = join(root, dirname(rel));
  const src = readFileSync(join(root, rel), 'utf8');
  if (/https?:\/\//.test(src) || /(?:src|href|url\(|action)\s*[=(:]\s*["']?file:\/\//.test(src))
    bad(`외부/파일 절대 참조 토큰 존재: ${rel}`);
  const refs = [...src.matchAll(/(?:href|src)="([^"#]+)(#[^"]*)?"/g)];
  const ids = new Set([...src.matchAll(/id="([^"]+)"/g)].map((x) => x[1]));
  for (const [, target, frag] of refs) {
    if (/^(data:|mailto:|tel:|javascript:)/.test(target)) { bad(`비허용 프로토콜 참조: ${rel} -> ${target}`); continue; }
    if (target === '' && frag) { anchorChecks++; if (!ids.has(frag.slice(1))) bad(`앵커 결번: ${rel} ${frag}`); continue; }
    if (target && !/\.html$/.test(target) && !/^(index|concept-\d\d)\.html$/.test(target)) continue; // 이미지/CSS 등 상대 파일도 아래에서 확인
    const resolved = resolve(dir, target);
    anchorChecks++;
    if (!statSync(resolved, { throwIfNoEntry: false })) bad(`상대 링크 대상 없음: ${rel} -> ${target}`);
  }
}
ok(`HTML 11개: 내부 참조/앵커 ${anchorChecks}건 점검, 금지 토큰 없음 (누적 오류 ${failures.length}건)`);

if (failures.length) { console.error(`\n${failures.length}건 실패`); process.exit(1); }
console.log('\nALL PASS');
