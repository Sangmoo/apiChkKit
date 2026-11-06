import { useMemo, useState } from 'react'
import { Method, Badge, sourceLabel, CONF_LABEL } from './common.jsx'

function splitUrl(url) {
  const m = url.match(/^(https?:\/\/[^/]+)(.*)$/)
  return m ? [m[1], m[2] || '/'] : ['', url]
}

export default function EndpointList({ endpoints, selectedId, onSelect, onAdd, onClear }) {
  const [q, setQ] = useState('')
  const [minConf, setMinConf] = useState('all')
  const filtered = useMemo(() => {
    const qq = q.trim().toLowerCase()
    return endpoints.filter((e) => {
      if (minConf === 'high' && e.confidence !== 'high') return false
      if (minConf === 'medium' && e.confidence === 'low') return false
      if (!qq) return true
      return `${e.method} ${e.url} ${e.summary} ${e.tags.join(' ')} ${e.params.map((p) => p.name).join(' ')}`.toLowerCase().includes(qq)
    })
  }, [endpoints, q, minConf])

  const groups = useMemo(() => {
    const g = new Map()
    for (const e of filtered) {
      const [host] = splitUrl(e.url)
      const key = e.tags?.[0] && e.sources.includes('openapi') ? `${host} · ${e.tags[0]}` : host
      if (!g.has(key)) g.set(key, [])
      g.get(key).push(e)
    }
    return [...g.entries()]
  }, [filtered])

  return (
    <div className="card ep-list">
      <div className="card-h">
        엔드포인트 <Badge>{endpoints.length}</Badge>
        <span className="spacer" />
        <button className="btn sm" onClick={onAdd} title="URL을 직접 입력해 엔드포인트 추가">
          ＋ 추가
        </button>
        <button className="btn sm ghost danger" onClick={onClear} title="모두 지우기">
          비우기
        </button>
      </div>
      <div style={{ padding: 8, borderBottom: '1px solid var(--border)' }} className="row">
        <input className="input grow" placeholder="검색 (경로, 파라미터명…)" value={q} onChange={(e) => setQ(e.target.value)} />
        <select className="select" style={{ width: 'auto' }} value={minConf} onChange={(e) => setMinConf(e.target.value)} title="신뢰도 필터">
          <option value="all">전체</option>
          <option value="medium">추정 이상</option>
          <option value="high">확실만</option>
        </select>
      </div>
      <div className="scroll">
        {groups.map(([host, list]) => (
          <div key={host}>
            <div className="ep-group" title={host}>
              {host || '(상대 경로)'} · {list.length}
            </div>
            {list.map((e) => {
              const [, path] = splitUrl(e.url)
              const runs = e.runs?.length || 0
              return (
                <div key={e.id} className={`ep-item ${selectedId === e.id ? 'sel' : ''}`} onClick={() => onSelect(e.id)}>
                  <Method m={e.method} />
                  <div className="grow">
                    <div className="path">{path}</div>
                    <div className="sub">
                      {e.summary && <span style={{ color: 'var(--text)' }}>{e.summary.slice(0, 60)}</span>}
                      <Badge kind={e.confidence}>{CONF_LABEL[e.confidence]}</Badge>
                      {e.sources.map((s) => (
                        <Badge key={s}>{sourceLabel(s)}</Badge>
                      ))}
                      {e.params.length > 0 && <Badge>조건 {e.params.length}</Badge>}
                      {Object.keys(e.responses).length > 0 && <Badge kind="accent">응답구조 ✓</Badge>}
                      {runs > 0 && <Badge kind="ok">테스트 {runs}</Badge>}
                      {e.deprecated && <Badge kind="err">deprecated</Badge>}
                    </div>
                  </div>
                </div>
              )
            })}
          </div>
        ))}
        {!filtered.length && <div className="empty small">조건에 맞는 엔드포인트가 없습니다</div>}
      </div>
    </div>
  )
}
