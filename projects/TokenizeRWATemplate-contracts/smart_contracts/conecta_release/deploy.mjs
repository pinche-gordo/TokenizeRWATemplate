// Canonical one-time deployment/recovery of the reviewed Conecta applications.
// Based on the official ARC-56 AppFactory/create and atomic-group documentation.
import assert from 'node:assert/strict';
import {createHash,randomBytes} from 'node:crypto';
import {createRequire} from 'node:module';
import {readFileSync,writeFileSync,renameSync,statSync,mkdirSync,openSync,closeSync,fsyncSync} from 'node:fs';
import {dirname,resolve,join} from 'node:path';
import {fileURLToPath} from 'node:url';

const genesis='SGO1GKSzyE7IEPItTxCByw9x8FmnrCDexi9/cOUJOiI=';
const sha=b=>createHash('sha256').update(b).digest('hex');
const here=dirname(fileURLToPath(import.meta.url));
const artifacts={escrow:readFileSync(resolve(here,'../artifacts/conecta_escrow/ConectaEscrow.arc56.json')),daily:readFileSync(resolve(here,'../artifacts/conecta_daily_reward/ConectaDailyReward.arc56.json'))};
export function validateConfiguration(config,sdk,{localAcceptance=false}={}){
 assert.equal(config.schemaVersion,1);assert.ok(sdk.isValidAddress(config.operator));
 assert.equal(config.treasury,config.operator,'Owner selected the existing hot wallet for both roles');
 const url=new URL(config.algodUrl);assert.ok(!url.username&&!url.password&&!url.search&&!url.hash&&url.pathname==='/');
 if(localAcceptance){assert.equal(config.network,'localnet');assert.equal(url.protocol,'http:');assert.ok(['127.0.0.1','localhost'].includes(url.hostname));}
 else{assert.equal(config.network,'testnet');assert.equal(url.protocol,'https:');assert.equal(config.assetId,757449774);assert.equal(config.genesisHash,genesis);assert.equal(config.genesisId,'testnet-v1.0');}
 assert.ok(Number.isSafeInteger(config.assetId)&&config.assetId>0);
 assert.equal(Buffer.from(config.genesisHash,'base64').length,32);
 return config;
}
export function saveJournal(path,value){
 mkdirSync(dirname(path),{recursive:true,mode:0o700});
 assert.equal(statSync(dirname(path)).mode&0o077,0,'Journal directory must stay private');
 const temporary=path+'.'+randomBytes(6).toString('hex');
 const fd=openSync(temporary,'wx',0o600);
 try{writeFileSync(fd,JSON.stringify(value,null,2)+'\n');fsyncSync(fd);}finally{closeSync(fd);}
 renameSync(temporary,path);
 const directory=openSync(dirname(path),'r');try{fsyncSync(directory);}finally{closeSync(directory);}
}
export async function deployConecta({sdk,algod,account,config,journalPath,action='deploy-paused',localAcceptance=false,afterBroadcast=async()=>{}}){
 validateConfiguration(config,sdk,{localAcceptance});assert.equal(account.addr.toString(),config.operator);
 assert.ok(['deploy-paused','accept','pause'].includes(action));
 const specs=Object.fromEntries(Object.entries(artifacts).map(([key,bytes])=>[key,JSON.parse(bytes)]));
 const binding={...config,artifacts:Object.fromEntries(Object.entries(artifacts).map(([k,b])=>[k,sha(b)]))};
 let journal;
 try{journal=JSON.parse(readFileSync(journalPath));assert.equal(statSync(journalPath).mode&0o077,0,'Deployment journal must stay private');assert.deepEqual(journal.binding,binding,'Journal belongs to another immutable deployment');}
 catch(error){if(error.code!=='ENOENT')throw error;journal={schemaVersion:1,binding,steps:{}};saveJournal(journalPath,journal);}
 const params=await algod.getTransactionParams().do();
 assert.equal(params.genesisID,config.genesisId);assert.equal(Buffer.from(params.genesisHash).toString('base64'),config.genesisHash);
 const asset=await algod.getAssetByID(config.assetId).do();assert.equal(asset.params.decimals,0);
 const operator=await algod.accountInformation(config.operator).do();assert.ok(operator.amount-operator.minBalance>=2_000_000n,'Require a bounded two-ALGO operational reserve');
 assert.ok(operator.assets?.some(a=>a.assetId===BigInt(config.assetId)&&!a.isFrozen),'Operator MGST opt-in required');
 const persist=()=>saveJournal(journalPath,journal);
 async function execute(key,builder){
  if(!journal.steps[key]){
   const suggested=await algod.getTransactionParams().do();
   assert.equal(suggested.genesisID,config.genesisId);assert.equal(Buffer.from(suggested.genesisHash).toString('base64'),config.genesisHash);
   assert.ok(suggested.minFee>0n&&suggested.minFee<=5000n,'Unexpected network fee');
   const transaction=await builder({...suggested,flatFee:true,fee:suggested.minFee,lastValid:suggested.firstValid+100n});
   assert.equal(transaction.sender.toString(),config.operator);assert.ok(transaction.fee<=10000n&&!transaction.rekeyTo);
   journal.steps[key]={txId:transaction.txID(),signed:Buffer.from(transaction.signTxn(account.sk)).toString('base64')};persist();
  }
  const step=journal.steps[key];if(step.confirmedRound)return step;
  // Signed intent is durable before network submission. An uncertain/expired
  // transaction is never silently replaced with another application creation.
  let receipt;
  try{receipt=await algod.pendingTransactionInformation(step.txId).do();}catch{}
  if(!(receipt?.confirmedRound>0n)){
   await algod.sendRawTransaction(Buffer.from(step.signed,'base64')).do();
   await afterBroadcast(key,step.txId);
   receipt=await sdk.waitForConfirmation(algod,step.txId,8);
  }
  assert.ok(receipt.confirmedRound>0n);step.confirmedRound=receipt.confirmedRound.toString();
  if(receipt.applicationIndex)step.appId=Number(receipt.applicationIndex);persist();return step;
 }
 function methodTransaction(kind,name,args,params,appId=0){
  const spec=specs[kind],method=sdk.ABIMethod.fromSignature(new sdk.ABIMethod(spec.methods.find(m=>m.name===name)).getSignature());
  const atc=new sdk.AtomicTransactionComposer();
  atc.addMethodCall({appID:appId,sender:config.operator,suggestedParams:params,method,methodArgs:args,
   signer:sdk.makeBasicAccountTransactionSigner(account),appForeignAssets:[config.assetId],
   ...(appId?{}:{approvalProgram:Buffer.from(spec.byteCode.approval,'base64'),clearProgram:Buffer.from(spec.byteCode.clear,'base64'),
    numGlobalInts:spec.state.schema.global.ints,numGlobalByteSlices:spec.state.schema.global.bytes,numLocalInts:0,numLocalByteSlices:0})});
  const group=atc.buildGroup();assert.equal(group.length,1);return group[0].txn;
 }
 const ids={};
 async function verifyApp(kind,id){
  const app=await algod.getApplicationByID(id).do(),spec=specs[kind];
  assert.equal(app.params.creator.toString(),config.operator);assert.equal(Buffer.from(app.params.approvalProgram).toString('base64'),spec.byteCode.approval);assert.equal(Buffer.from(app.params.clearStateProgram).toString('base64'),spec.byteCode.clear);
  const state=Object.fromEntries(app.params.globalState.map(r=>[Buffer.from(r.key).toString(),r.value]));
  assert.equal(state.mgst.uint,BigInt(config.assetId));assert.equal(sdk.encodeAddress(state.operator.bytes),config.operator);
  if(kind==='escrow')assert.equal(sdk.encodeAddress(state.treasury.bytes),config.treasury);
  return state;
 }
 for(const kind of ['escrow','daily']){
  const created=await execute(kind+'-create',p=>methodTransaction(kind,'createApplication',kind==='escrow'?[config.assetId,config.operator,config.treasury]:[config.assetId,config.operator],p));
  assert.ok(Number.isSafeInteger(created.appId)&&created.appId>0);ids[kind]=created.appId;
  // Confirm the immutable program/recipient binding before sending base funds.
  await verifyApp(kind,created.appId);
  const appAddress=sdk.getApplicationAddress(created.appId).toString();
  await execute(kind+'-base-fund',p=>sdk.makePaymentTxnWithSuggestedParamsFromObject({sender:config.operator,receiver:appAddress,amount:kind==='escrow'?200000n:100000n,suggestedParams:p}));
  if(kind==='escrow')await execute('escrow-asset-opt-in',p=>methodTransaction(kind,'optInAsset',[],{...p,fee:p.fee*2n},created.appId));
 }
 if(action!=='deploy-paused')for(const kind of ['escrow','daily']){
  const info=await algod.getApplicationByID(ids[kind]).do();
  const current=info.params.globalState.find(r=>Buffer.from(r.key).toString()==='accepting').value.uint;
  const prefix=kind+'-'+action+'-',prior=Object.keys(journal.steps).filter(k=>k.startsWith(prefix));
  const pending=prior.find(k=>!journal.steps[k].confirmedRound);
  if(pending||Boolean(current)!==(action==='accept'))await execute(pending||prefix+(prior.length+1),p=>methodTransaction(kind,'setAccepting',[action==='accept'],p,ids[kind]));
 }
 const publicResult={schemaVersion:1,network:config.network,assetId:config.assetId,operator:config.operator,treasury:config.treasury,apps:ids,accepting:action==='accept',transactions:{}};
 for(const [key,s]of Object.entries(journal.steps))publicResult.transactions[key]=s.txId;
 for(const kind of ['escrow','daily']){
  const state=await verifyApp(kind,ids[kind]);
  assert.equal(Boolean(state.accepting.uint),action==='accept','Unexpected live accepting state');
 }
 return publicResult;
}
if(process.argv[1]&&resolve(process.argv[1])===fileURLToPath(import.meta.url)){
 // Explicit SDK owner root; never install dependencies or retrieve keys remotely.
 const [action,configuration,journalPath,sdkRoot]=process.argv.slice(2);
 assert.ok(action&&configuration&&journalPath&&sdkRoot,'Usage: node deploy.mjs deploy-paused|accept|pause configuration.json private-journal.json sdk-owner-root');
 const require=createRequire(join(resolve(sdkRoot),'package.json')),sdk=require('algosdk');
 const config=JSON.parse(readFileSync(configuration));validateConfiguration(config,sdk);
 const account=sdk.mnemonicToSecretKey(process.env.MYGLOBAL_REWARD_HOT_WALLET_MNEMONIC||'');
 assert.equal(account.addr.toString(),process.env.MYGLOBAL_REWARD_HOT_WALLET_ADDRESS);
 const algod=new sdk.Algodv2('',config.algodUrl,'');
 try{console.log(JSON.stringify(await deployConecta({sdk,algod,account,config,journalPath,action})));}
 catch{console.error('Conecta deployment/recovery did not complete. Preserve the private journal; no automatic replacement is permitted.');process.exitCode=1;}
}
