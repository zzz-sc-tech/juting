import fs from 'node:fs'
const {extractDialogueAnchors}=await import('../../packages/domain/src/dialogueAnchors.ts')
const {buildStudySections}=await import('../../web-app/src/lib/studySections.ts')
const W={one:1,two:2,three:3,four:4,five:5,six:6,seven:7,eight:8,nine:9,ten:10,eleven:11,twelve:12,thirteen:13,fourteen:14,fifteen:15,sixteen:16,seventeen:17,eighteen:18,nineteen:19,twenty:20}
const pn=s=>{
  const m=s.match(/^(?:Questions?|Q)\s*((?:twenty[\s-])?(?:one|two|three|four|five|six|seven|eight|nine|ten|eleven|twelve|thirteen|fourteen|fifteen|sixteen|seventeen|eighteen|nineteen)|twenty|\d{1,2})\b/i)
  if(!m)return null
  const v=m[1].toLowerCase().replace(/[\s-]+/,'-')
  if(/^\d+$/.test(v))return +v
  if(v==='twenty')return 20
  if(v.startsWith('twenty-'))return 20+(W[v.slice(7)]??0)
  return W[v]??null
}
for(const name of ['cet4','cet6']){
  const seed=JSON.parse(fs.readFileSync(`presets/${name}/seed.json`,'utf8'))
  let bad=0,tot=0
  const issues=[]
  for(const ex of seed.exercises){
    const full=ex.transcript_json.map(l=>({id:l.id,start:l.start,end:l.end,text:l.text}))
    const anchors=extractDialogueAnchors(full)
    const instr=new Set(anchors.flatMap(a=>a.lineIds))
    const study=full.filter(l=>!instr.has(l.id))
    const secs=buildStudySections(full,anchors,study,'开场')
    for(const s of secs){
      if(!s.anchor||s.anchor.kind!=='question-range') continue
      const m=s.label.match(/Q(\d+)[–-]?(\d+)?/)
      if(!m)continue
      const lo=+m[1],hi=m[2]?+m[2]:lo
      const nums=new Set()
      for(let k=lo;k<=hi;k++)nums.add(k)
      tot++
      // 组内出现过的题号（去重）
      const seen=new Set()
      s.lines.forEach(l=>{const n=pn(l.text.trim()); if(n!==null&&nums.has(n)&&!/based\s+on/i.test(l.text))seen.add(n)})
      if(seen.size!==nums.size){bad++;if(issues.length<10)issues.push(`#${ex.id} ${s.label}: 缺 Q${[...nums].filter(n=>!seen.has(n)).join(',Q')}`)}
    }
  }
  console.log(`${name}: 题组 ${tot}，缺题 ${bad}`)
  issues.forEach(i=>console.log('  '+i))
}
