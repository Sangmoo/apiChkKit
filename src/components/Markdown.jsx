// Claude 답변용 간단한 마크다운 렌더러 (HTML 삽입 없이 React 요소로만 그린다)

function inline(text, keyBase = '') {
  const out = []
  const re = /(`[^`]+`)|(\*\*[^*]+\*\*)|(\[[^\]]+\]\((https?:\/\/[^)\s]+)\))/g
  let last = 0
  let m
  let i = 0
  while ((m = re.exec(text))) {
    if (m.index > last) out.push(text.slice(last, m.index))
    const k = `${keyBase}-${i++}`
    if (m[1]) out.push(<code key={k}>{m[1].slice(1, -1)}</code>)
    else if (m[2]) out.push(<b key={k}>{m[2].slice(2, -2)}</b>)
    else if (m[3]) {
      const label = m[3].slice(1, m[3].indexOf(']'))
      out.push(
        <a key={k} href={m[4]} target="_blank" rel="noreferrer">
          {label}
        </a>,
      )
    }
    last = re.lastIndex
  }
  if (last < text.length) out.push(text.slice(last))
  return out
}

const splitRow = (l) =>
  l
    .trim()
    .replace(/^\||\|$/g, '')
    .split('|')
    .map((c) => c.trim())

export default function Markdown({ text }) {
  const lines = (text || '').replace(/\r/g, '').split('\n')
  const blocks = []
  let i = 0
  let key = 0
  while (i < lines.length) {
    const line = lines[i]
    if (/^```/.test(line)) {
      const buf = []
      i++
      while (i < lines.length && !/^```/.test(lines[i])) buf.push(lines[i++])
      i++
      blocks.push(
        <pre className="code" key={key++}>
          {buf.join('\n')}
        </pre>,
      )
      continue
    }
    if (/^\s*\|.*\|\s*$/.test(line) && /^\s*\|?\s*:?-{2,}/.test(lines[i + 1] || '')) {
      const head = splitRow(line)
      i += 2
      const rows = []
      while (i < lines.length && /^\s*\|.*\|\s*$/.test(lines[i])) rows.push(splitRow(lines[i++]))
      blocks.push(
        <div className="table-wrap" key={key++} style={{ margin: '8px 0' }}>
          <table className="t">
            <thead>
              <tr>
                {head.map((h, j) => (
                  <th key={j}>{inline(h, `h${j}`)}</th>
                ))}
              </tr>
            </thead>
            <tbody>
              {rows.map((r, ri) => (
                <tr key={ri}>
                  {r.map((c, ci) => (
                    <td key={ci}>{inline(c, `c${ri}-${ci}`)}</td>
                  ))}
                </tr>
              ))}
            </tbody>
          </table>
        </div>,
      )
      continue
    }
    const h = line.match(/^(#{1,4})\s+(.*)$/)
    if (h) {
      const Tag = `h${Math.min(h[1].length + 2, 6)}`
      blocks.push(<Tag key={key++}>{inline(h[2], `t${key}`)}</Tag>)
      i++
      continue
    }
    if (/^\s*([-*]|\d+\.)\s+/.test(line)) {
      const ordered = /^\s*\d+\./.test(line)
      const items = []
      while (i < lines.length && /^\s*([-*]|\d+\.)\s+/.test(lines[i])) {
        const depth = (lines[i].match(/^\s*/)[0].length / 2) | 0
        items.push({ depth, text: lines[i].replace(/^\s*([-*]|\d+\.)\s+/, '') })
        i++
      }
      const List = ordered ? 'ol' : 'ul'
      blocks.push(
        <List key={key++}>
          {items.map((it, j) => (
            <li key={j} style={{ marginLeft: it.depth * 16 }}>
              {inline(it.text, `l${j}`)}
            </li>
          ))}
        </List>,
      )
      continue
    }
    if (/^>\s?/.test(line)) {
      const buf = []
      while (i < lines.length && /^>\s?/.test(lines[i])) buf.push(lines[i++].replace(/^>\s?/, ''))
      blocks.push(<blockquote key={key++}>{inline(buf.join(' '), `q${key}`)}</blockquote>)
      continue
    }
    if (/^\s*(-{3,}|\*{3,})\s*$/.test(line)) {
      blocks.push(<hr key={key++} />)
      i++
      continue
    }
    if (!line.trim()) {
      i++
      continue
    }
    const buf = []
    while (i < lines.length && lines[i].trim() && !/^(```|#{1,4}\s|\s*([-*]|\d+\.)\s|>|\s*\|)/.test(lines[i])) buf.push(lines[i++])
    if (!buf.length) buf.push(lines[i++])
    blocks.push(<p key={key++}>{inline(buf.join(' '), `p${key}`)}</p>)
  }
  return <div className="md">{blocks}</div>
}
