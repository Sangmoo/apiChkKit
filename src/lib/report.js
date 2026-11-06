// 분석 결과를 Markdown 리포트 / 프로젝트 JSON 으로 내보내기
import { flattenSchema } from './schema.js'

const esc = (s) => String(s ?? '').replace(/\|/g, '\\|').replace(/\n/g, ' ')
const fmtVal = (v) => (v === undefined || v === null || v === '' ? '' : typeof v === 'object' ? JSON.stringify(v) : String(v))

export function toMarkdown(endpoints, meta = {}) {
  const lines = [`# API Check Kit 리포트`, '']
  if (meta.target) lines.push(`- 대상: ${meta.target}`)
  lines.push(`- 생성: ${new Date().toLocaleString()}`, `- 엔드포인트: ${endpoints.length}개`, '')
  lines.push('| Method | URL | 출처 | 신뢰도 |', '|---|---|---|---|')
  for (const ep of endpoints) lines.push(`| ${ep.method} | \`${esc(ep.url)}\` | ${ep.sources.join(', ')} | ${ep.confidence} |`)
  lines.push('')
  for (const ep of endpoints) {
    lines.push(`## ${ep.method} ${ep.url}`, '')
    if (ep.summary) lines.push(`**${ep.summary}**`, '')
    if (ep.description) lines.push(ep.description, '')
    if (ep.params.length) {
      lines.push('### 요청 조건값', '', '| 이름 | 위치 | 타입 | 필수 | 예시/관측값 | 설명 |', '|---|---|---|---|---|---|')
      for (const p of ep.params) {
        const ex = [fmtVal(p.example), ...(p.observed || []).map(fmtVal)].filter(Boolean)
        const enumTxt = p.enum?.length ? `허용값: ${p.enum.join(', ')}` : ''
        lines.push(`| ${esc(p.name)} | ${p.in} | ${esc(p.type)} | ${p.required ? '✓' : ''} | ${esc([...new Set(ex)].slice(0, 5).join(', '))} | ${esc([p.description, enumTxt, p.note].filter(Boolean).join(' · '))} |`)
      }
      lines.push('')
    }
    for (const [st, r] of Object.entries(ep.responses)) {
      lines.push(`### 응답 ${st} ${r.description ? `— ${esc(r.description)}` : ''}`, '')
      const rows = flattenSchema(r.schema)
      if (rows.length) {
        lines.push('| 필드 | 타입 | 예시값 | 설명 |', '|---|---|---|---|')
        for (const row of rows.slice(0, 200)) lines.push(`| \`${esc(row.path)}\` | ${esc(row.type)} | ${esc((row.examples || []).map(fmtVal).join(', ').slice(0, 120))} | ${esc(row.description)} |`)
        lines.push('')
      }
    }
    const runs = ep.runs || []
    if (runs.length) {
      lines.push('### 조건별 결과 (테스트 기록)', '', '| 조건 | 상태 | 시간 | 결과 요약 |', '|---|---|---|---|')
      for (const r of runs.slice(-30)) lines.push(`| ${esc(r.label)} | ${r.status} | ${r.time}ms | ${esc(r.summary)} |`)
      lines.push('')
    }
  }
  return lines.join('\n')
}

export function download(filename, text, type = 'text/plain') {
  const a = document.createElement('a')
  a.href = URL.createObjectURL(new Blob([text], { type }))
  a.download = filename
  document.body.appendChild(a)
  a.click()
  setTimeout(() => {
    URL.revokeObjectURL(a.href)
    a.remove()
  }, 500)
}
