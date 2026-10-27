import fs from 'node:fs'
for(const n of ['cet4','cet6']){
  const d=JSON.parse(fs.readFileSync(`presets/${n}/seed.json`,'utf8'))
  let mono=true,ov=0,neg=0,noTr=0
  const L=[]
  for(const e of d['exercises']){
    const T=e.transcript_json
    for(let i=0;i<T.length;i++){
      L.push(T[i])
      if(T[i].end<T[i].start)neg++
      if(i>0){if(T[i].start<T[i-1].start-0.01)mono=false;if(T[i-1].end>T[i].start+0.01)ov++}
    }
  }
  console.log(`${n}: ${d['exercises'].length}课 ${L.length}行 v${d['version']} | 单调=${mono} 重叠=${ov} 负时长=${neg}`)
}
