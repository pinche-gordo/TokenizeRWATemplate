// Exact first-live source proof. Historical guards receive only verified inverse
// edits; current product tests always execute the actual current application.
import assert from 'node:assert/strict'
import {readFileSync, lstatSync, readlinkSync} from 'node:fs'
import {execFileSync} from 'node:child_process'
import {createHash} from 'node:crypto'
import {fileURLToPath} from 'node:url'
import {resolve, relative, sep} from 'node:path'

const MANIFEST='docs/conecta-full-prize-scope.json'
const BASES={app:'7543635dd3a5e512191299e90926651d3d8812f4',game:'4feed311602370e92111b9415c7b7d2d6176f6c3',contracts:'ca9ffaf27aca0d8b63ea6178d5fe123ae1fe0164'}
const sha=bytes=>createHash('sha256').update(bytes).digest('hex')
const blob=bytes=>createHash('sha1').update(`blob ${bytes.length}\0`).update(bytes).digest('hex')
const own=(object,key)=>Object.hasOwn(object,key)

export function createFullPrizeScope(directory){
 const root=resolve(directory)
 const git=(...args)=>execFileSync('git',args,{cwd:root,maxBuffer:64*1024*1024})
 const pathFor=path=>{
  assert.ok(typeof path==='string'&&path&&path!=='..'&&!path.includes('\0'),'Invalid scoped path')
  const absolute=resolve(root,path)
  assert.ok(absolute.startsWith(root+sep),'Scoped path escapes owner: '+path)
  return absolute
 }
 const scope=()=>{
  const value=JSON.parse(readFileSync(pathFor(MANIFEST),'utf8'))
  assert.equal(value.schemaVersion,1);assert.equal(value.phase,'full_prize_first_live_candidate')
  assert.equal(value.productionAccepted,false);assert.equal(value.invitations,'deferred')
  assert.ok(own(BASES,value.owner));assert.equal(value.reviewedBase,BASES[value.owner],'Full-prize base changed')
  return value
 }
 const bytesFor=(path,mode)=>{
  const absolute=pathFor(path),stat=lstatSync(absolute)
  if(mode==='120000'){assert.ok(stat.isSymbolicLink(),'Protected link type changed: '+path);return Buffer.from(readlinkSync(absolute))}
  assert.ok(stat.isFile()&&!stat.isSymbolicLink(),'Scoped source must be a regular file: '+path)
  assert.equal(stat.mode&0o111,mode==='100755'?0o111:0,'Scoped executable mode changed: '+path)
  return readFileSync(absolute)
 }
 const treeAt=base=>Object.fromEntries(git('ls-tree','-r','-z',base).toString().split('\0').filter(Boolean).map(row=>{
  const split=row.indexOf('\t'),[mode,type,digest]=row.slice(0,split).split(' ')
  assert.equal(type,'blob','Submodules require a separately reviewed scope')
  return [row.slice(split+1),{mode,blob:digest}]
 }))
 const targetFor=(entry,path,value)=>{
  const origin=entry.origin
  assert.equal(origin.commit,value.reviewedBase,'Inverse must use the pinned owner base')
  if(origin.kind==='retained-merchant-v2-guard'){
   assert.equal(value.owner,'app');assert.equal(path,'scripts/verify-conecta-merchant-v2-scope.mjs')
   assert.equal(sha(entry.beforeText),'b7d7157bd9ab8b8bf389ae6866284ea89bada26715ebc9301757aedb43010eb8','Archived v2 verifier changed')
   assert.equal(sha(entry.beforeText),entry.beforeSha256)
   return entry.beforeText
  }
  let source=git('show',origin.commit+':'+path).toString('utf8')
  if(origin.kind==='merchant-v2-hooks'){
   assert.equal(value.owner,'app');assert.ok(['server.js','src/components/panel-v2/MemberPanelV2RewardsLivePanel.jsx'].includes(path))
   const priorPath='docs/conecta-merchant-v2-scope.json',priorBytes=readFileSync(pathFor(priorPath))
   assert.equal(sha(priorBytes),origin.manifestSha256,'Frozen merchant-v2 manifest changed')
   const prior=JSON.parse(priorBytes),hooks=prior.sourceEdits[path]
   assert.equal(prior.reviewedBase,origin.commit);assert.equal(sha(source),hooks.sha256)
   for(const {before,after} of hooks.edits){
    assert.ok(before&&after&&before!==after);assert.equal(source.split(before).length,2,'Historical hook no longer unique: '+path)
    source=source.replace(before,()=>after)
   }
  }else assert.equal(origin.kind,'git','Unknown historical source origin')
  assert.equal(sha(source),entry.beforeSha256,'Inverse baseline disagrees with retained history: '+path)
  return source
 }
 const inverse=(path,value)=>{
  const entry=value.projections[path],current=value.files[path]
  assert.ok(entry&&current,'Inverse needs an explicitly pinned current source: '+path)
  let source=bytesFor(path,current.mode).toString('utf8')
  assert.equal(sha(source),current.sha256,'Current full-prize source drift: '+path)
  assert.ok(entry.edits.length,'Inverse substitutions must not be omitted: '+path)
  for(const {before,after} of [...entry.edits].reverse()){
   assert.ok(typeof before==='string'&&typeof after==='string'&&after&&before!==after,'Invalid inverse substitution: '+path)
   assert.equal(source.split(after).length,2,'Missing/duplicated exact full-prize hook: '+path)
   source=source.replace(after,()=>before)
  }
  assert.equal(source,targetFor(entry,path,value),'Source changed beyond exact first-live hooks: '+path)
  return Buffer.from(source)
 }
 function verify(){
  const value=scope(),tree=treeAt(value.reviewedBase)
  assert.deepEqual(Object.keys(value.protectedFiles).sort(),Object.keys(tree).filter(path=>!own(value.files,path)).sort(),'Protected inventory must cover every other tracked source')
  for(const [path,entry] of Object.entries(value.protectedFiles)){
   assert.deepEqual(entry,tree[path],'Protected Git fingerprint changed: '+path)
   assert.equal(blob(bytesFor(path,entry.mode)),entry.blob,'Protected source drift: '+path)
  }
  assert.ok(!own(value.files,MANIFEST),'Manifest cannot self-attest its own hash')
  for(const [path,entry] of Object.entries(value.files)){
   assert.match(entry.sha256,/^[a-f0-9]{64}$/)
   assert.equal(sha(bytesFor(path,entry.mode)),entry.sha256,'Current full-prize source drift: '+path)
  }
  const changes=[...git('diff','--name-only','-z',value.reviewedBase).toString().split('\0'),...git('ls-files','--others','--exclude-standard','-z').toString().split('\0')].filter(Boolean)
  for(const path of changes)assert.ok(path===MANIFEST||own(value.files,path),'Unlisted full-prize source: '+path)
  assert.deepEqual(Object.keys(value.projections).sort(),value.projectionPaths,'Required inverse inventory changed')
  const retained=new Set()
  if(value.owner==='app'){
   const prior=JSON.parse(readFileSync(pathFor('docs/conecta-merchant-v2-scope.json'),'utf8'))
   for(const [path,entry] of Object.entries(prior.legacyManifestEdits)){
    assert.equal(sha(readFileSync(pathFor(path))),entry.afterSha256,'Retained v2 manifest drift: '+path);retained.add(path)
   }
   const path='src/components/panel-v2/MemberPanelV2RewardsLivePanel.jsx'
   const entry={beforeSha256:sha(readFileSync(pathFor(path))),origin:{kind:'merchant-v2-hooks',commit:value.reviewedBase,manifestSha256:sha(readFileSync(pathFor('docs/conecta-merchant-v2-scope.json')))}}
   targetFor(entry,path,value);retained.add(path)
  }
  for(const path of Object.keys(value.files))if(own(tree,path)&&!retained.has(path))assert.ok(own(value.projections,path),'Tracked full-prize change lacks its inverse: '+path)
  assert.equal(new Set(value.introducedPaths).size,value.introducedPaths.length)
  for(const path of value.introducedPaths){assert.ok(path===MANIFEST||own(value.files,path));assert.ok(!own(tree,path),'Introduced source already exists in Git: '+path)}
  for(const path of Object.keys(value.projections)){assert.ok(!value.introducedPaths.includes(path));inverse(path,value)}
  return {owner:value.owner,phase:value.phase,productionAccepted:false,files:Object.keys(value.files).length,protectedFiles:Object.keys(value.protectedFiles).length}
 }
 function readBaseline(file,options){
  const absolute=file instanceof URL?fileURLToPath(file):resolve(String(file)),path=relative(root,absolute),value=scope()
  const bytes=own(value.projections,path)?inverse(path,value):readFileSync(file)
  const encoding=typeof options==='string'?options:options?.encoding
  return encoding?bytes.toString(encoding):bytes
 }
 function legacyPaths(paths,base){
  // This proof precedes any historical path projection. It rejects an unlisted
  // file anywhere in the owner, even if the caller supplied only a short list.
  verify()
  const value=scope(),tree=treeAt(base)
  return paths.filter(path=>{
   if(value.introducedPaths.includes(path))return false
   if(own(value.projections,path)){
    const bytes=inverse(path,value)
    return !own(tree,path)||tree[path].blob!==blob(bytes)
   }
   return true
  })
 }
 return {verify,readBaseline,legacyPaths}
}

const instance=createFullPrizeScope(fileURLToPath(new URL('../',import.meta.url)))
export const verifyFullPrizeScope=instance.verify
export const readFullPrizeBaseline=instance.readBaseline
export const fullPrizeLegacyPaths=instance.legacyPaths
if(process.argv[1]&&resolve(process.argv[1])===fileURLToPath(import.meta.url))console.log(JSON.stringify(verifyFullPrizeScope()))
