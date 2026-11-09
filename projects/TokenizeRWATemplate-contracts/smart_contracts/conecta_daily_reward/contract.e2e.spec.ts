import {Config,microAlgos} from '@algorandfoundation/algokit-utils'
import {algorandFixture} from '@algorandfoundation/algokit-utils/testing'
import algosdk from 'algosdk'
import {randomBytes,randomUUID} from 'node:crypto'
import {beforeAll,describe,expect,test} from 'vitest'
import {ConectaDailyRewardFactory} from '../artifacts/conecta_daily_reward/ConectaDailyRewardClient'

const token='a'.repeat(64),ref=()=>new Uint8Array(randomBytes(32))
const localnet=algorandFixture({testAccountFunding:microAlgos(1_000_000_000),algodConfig:{server:'http://127.0.0.1',port:Number(process.env.CONECTA_TEST_ALGOD_PORT),token},kmdConfig:{server:'http://127.0.0.1',port:Number(process.env.CONECTA_TEST_KMD_PORT),token}})
describe('Conecta explicit daily reward real LocalNet',()=>{
 beforeAll(async()=>{expect(Number(process.env.CONECTA_TEST_ALGOD_PORT)).toBeGreaterThan(0);expect(Number(process.env.CONECTA_TEST_KMD_PORT)).toBeGreaterThan(0);await localnet.newScope();Config.configure({debug:false})})
 async function setup(){
  const {testAccount:creator,algod}=localnet.context,algorand=localnet.algorand
  const accounts=[]
  for(let n=0;n<3;n++){const account=algosdk.generateAccount();algorand.setSignerFromAccount(account);await algorand.send.payment({sender:creator.addr,receiver:account.addr,amount:microAlgos(10_000_000),suppressLog:true});accounts.push(account)}
  const [operator,player,other]=accounts
  const asset=await algorand.send.assetCreate({sender:creator.addr,total:1000n,decimals:0,assetName:'Conecta DAILY LOCAL',unitName:'LOCAL'})
  for(const a of accounts)await algorand.send.assetOptIn({sender:a.addr,assetId:asset.assetId})
  await algorand.send.assetTransfer({sender:creator.addr,receiver:operator.addr,assetId:asset.assetId,amount:100n})
  await algorand.send.assetTransfer({sender:creator.addr,receiver:other.addr,assetId:asset.assetId,amount:10n})
  const factory=algorand.client.getTypedAppFactory(ConectaDailyRewardFactory,{defaultSender:creator.addr}),{appClient:client}=await factory.send.create.createApplication({args:{asset:asset.assetId,operator:operator.addr.toString()}})
  await algorand.send.payment({sender:creator.addr,receiver:client.appAddress,amount:microAlgos(100000)})
  const status=await algod.status().do(),block=await algod.block(status.lastRound).do(),day=(block.block.header.timestamp-21600n)/86400n
  const balance=async(a=player)=>Number((await algod.accountAssetInformation(a.addr,asset.assetId).do()).assetHolding!.amount)
  type Patch={amount?:bigint;day?:bigint;player?:typeof player;sender?:typeof player;sponsor?:typeof player;funding?:bigint;note?:Uint8Array;closeTo?:string;rekeyTo?:string}
  async function pay(claimRef:Uint8Array,patch:Patch={}){
   const recipient=patch.player||player,sender=patch.sender||operator,sponsor=patch.sponsor||operator
   const transfer=await algorand.createTransaction.assetTransfer({sender:sender.addr,receiver:recipient.addr,assetId:asset.assetId,amount:patch.amount??5n,note:patch.note||new Uint8Array(Buffer.concat([Buffer.from('conecta:daily:v1:'),claimRef])),...(patch.closeTo?{closeAssetTo:patch.closeTo}:{}),...(patch.rekeyTo?{rekeyTo:patch.rekeyTo}:{})})
   if(patch.closeTo)expect(transfer.assetTransfer?.closeRemainderTo?.toString()).toBe(patch.closeTo)
   if(patch.rekeyTo)expect(transfer.rekeyTo?.toString()).toBe(patch.rekeyTo)
   const funding=await algorand.createTransaction.payment({sender:sponsor.addr,receiver:client.appAddress,amount:microAlgos(patch.funding??70000n)})
   return client.send.payDaily({sender:sender.addr,args:{transfer,sponsor:funding,player:recipient.addr.toString(),day:patch.day??day,claimRef}})
  }
  return {creator,operator,player,other,client,algod,algorand,asset,day,now:Number(block.block.header.timestamp)*1000,pay,balance}
 }
 test('only an explicit exact claim group pays five, with retained identity/day and wallet/day replay protection',async()=>{
  const f=await setup(),claimRef=ref();expect(await f.balance()).toBe(0)
  await expect(f.pay(claimRef)).rejects.toThrow();expect(await f.balance()).toBe(0)
  await f.client.send.setAccepting({args:{accepting:true}});expect(await f.balance()).toBe(0)
  const result=await f.pay(claimRef);expect(result.transactions).toHaveLength(3);expect(await f.balance()).toBe(5);expect(await f.balance(f.operator)).toBe(95)
  const saved=await f.client.getClaim({args:{claimRef}});expect(saved?.player).toBe(f.player.addr.toString());expect(saved?.day).toBe(f.day)
  await expect(f.pay(claimRef)).rejects.toThrow()
  await expect(f.pay(claimRef,{player:f.other})).rejects.toThrow()
  await expect(f.pay(ref())).rejects.toThrow()
  expect(await f.balance()).toBe(5);expect(await f.balance(f.other)).toBe(10)
  // A previously requested day's distinct identity commitment can recover later.
  await f.pay(ref(),{day:f.day-1n});expect(await f.balance()).toBe(10)
  await f.client.send.setAccepting({args:{accepting:false}});await expect(f.pay(ref(),{player:f.other})).rejects.toThrow();expect(await f.balance(f.other)).toBe(10)
 })
 test('wrong amounts, sponsor, note, future day, close/rekey, caller and extra group members all fail atomically',async()=>{
  const f=await setup();await f.client.send.setAccepting({args:{accepting:true}})
  for(const patch of [{amount:4n},{amount:6n},{funding:69999n},{sponsor:f.other},{day:f.day+1n},{day:0n},{note:new Uint8Array([1])},{closeTo:f.other.addr.toString()},{rekeyTo:f.other.addr.toString()},{sender:f.other}])await expect(f.pay(ref(),patch)).rejects.toThrow()
  await expect(f.client.send.setAccepting({sender:f.other.addr,args:{accepting:false}})).rejects.toThrow()
  await expect(f.pay(new Uint8Array(31))).rejects.toThrow()
  const claimRef=ref(),transfer=await f.algorand.createTransaction.assetTransfer({sender:f.operator.addr,receiver:f.player.addr,assetId:f.asset.assetId,amount:5n,note:new Uint8Array(Buffer.concat([Buffer.from('conecta:daily:v1:'),claimRef]))}),sponsor=await f.algorand.createTransaction.payment({sender:f.operator.addr,receiver:f.client.appAddress,amount:microAlgos(70000)})
  await expect(f.client.newGroup().addTransaction(await f.algorand.createTransaction.payment({sender:f.operator.addr,receiver:f.operator.addr,amount:microAlgos(0)})).payDaily({sender:f.operator.addr,args:{transfer,sponsor,player:f.player.addr.toString(),day:f.day,claimRef}}).send()).rejects.toThrow()
  expect(await f.balance()).toBe(0);expect(await f.balance(f.operator)).toBe(100);await f.pay(ref());expect(await f.balance()).toBe(5)
 })
 test('actual MYGLOBAL adapter verifies the canonical app and reconciles one signed daily group without relying on pending history',async()=>{
  const f=await setup();await f.client.send.setAccepting({args:{accepting:true}})
  const {createDailyRewardChain}=await import(/* @vite-ignore */ process.env.CONECTA_TEST_APP_ROOT+'/src/server/conecta-daily-reward-chain.js')
  const params=await f.algod.getTransactionParams().do(),options={algod:f.algod,appId:Number(f.client.appId),assetId:Number(f.asset.assetId),operator:f.operator.addr.toString(),genesisHash:Buffer.from(params.genesisHash!).toString('base64'),genesisId:'dockernet-v1',signOperator:(txn:algosdk.Transaction)=>txn.signTxn(f.operator.sk)}
  const adapter=createDailyRewardChain(options),context={claimId:randomUUID(),claimRef:Buffer.from(ref()).toString('hex'),wallet:f.player.addr.toString(),businessDay:new Date(Number(f.day)*86400000).toISOString().slice(0,10),epochDay:Number(f.day)}
  expect((await adapter.readiness()).ready).toBe(true);expect(await adapter.confirmedClaim(context)).toBe(null)
  expect((await createDailyRewardChain({...options,operator:f.other.addr.toString()}).readiness()).ready).toBe(false)
  expect((await createDailyRewardChain({...options,genesisId:'testnet-v1.0'}).readiness()).ready).toBe(false)
  await expect(createDailyRewardChain({...options,signOperator:(txn:algosdk.Transaction)=>txn.signTxn(f.other.sk)}).prepareClaim(context)).rejects.toThrow()
  const plan=await adapter.prepareClaim(context);expect(plan.blobs).toHaveLength(3);expect(await f.balance()).toBe(0)
  await adapter.broadcast(plan);await algosdk.waitForConfirmation(f.algod,plan.txId,4)
  const proof=await adapter.confirmedClaim(context);expect(proof.amount).toBe(5);expect(proof.wallet).toBe(f.player.addr.toString());expect(await f.balance()).toBe(5)
  await expect(adapter.confirmedClaim({...context,wallet:f.other.addr.toString()})).rejects.toThrow()
  // A replacement has a fresh transaction window/group but the same claim box.
  const replacement=await adapter.prepareClaim(context);await expect(adapter.broadcast(replacement)).rejects.toThrow();expect(await f.balance()).toBe(5)
 })
 test('durable MYGLOBAL daily broker reconciles actual chain payment after a lost reply and restart without another payout',async()=>{
  const f=await setup();await f.client.send.setAccepting({args:{accepting:true}})
  const root=process.env.CONECTA_TEST_APP_ROOT,{createDailyRewardChain}=await import(/* @vite-ignore */ root+'/src/server/conecta-daily-reward-chain.js'),{createDailyRewardBroker}=await import(/* @vite-ignore */ root+'/src/server/conecta-daily-reward-broker.js'),{withCampaignPostgres}=await import(/* @vite-ignore */ root+'/tests/helpers/conecta-prize-postgres.mjs'),{readFileSync}=await import('node:fs')
  const params=await f.algod.getTransactionParams().do(),chain=createDailyRewardChain({algod:f.algod,appId:Number(f.client.appId),assetId:Number(f.asset.assetId),operator:f.operator.addr.toString(),genesisHash:Buffer.from(params.genesisHash!).toString('base64'),genesisId:'dockernet-v1',signOperator:(txn:algosdk.Transaction)=>txn.signTxn(f.operator.sk)})
  await withCampaignPostgres(async(newPool:(name?:string)=>{query:(sql:string,values?:unknown[])=>Promise<{rows:{signed_plan:{txId:string}}[]}>})=>{
   const pool=newPool();await pool.query(readFileSync(root+'/db/sql/migrations/2026-11-08_conecta_daily_reward.sql','utf8'))
   let broadcasts=0,txId='';const adapter={...chain,broadcast:async(plan:{txId:string})=>{broadcasts++;txId=plan.txId;const stored=(await pool.query('SELECT signed_plan FROM conecta_daily_reward.claims')).rows[0];expect(stored.signed_plan.txId).toBe(plan.txId);await chain.broadcast(plan);throw Error('deliberate lost successful reply')}}
   const q={claimId:randomUUID(),subject:'102',wallet:f.player.addr.toString(),campaignId:randomUUID(),version:1,termsHash:'a'.repeat(64),issuerRef:randomUUID(),grantId:randomUUID(),claimDailyReward:true}
   const broker=()=>createDailyRewardBroker({pool,adapter,enabled:true,accepting:true,identitySecret:'isolated-stable-daily-identity-test-secret',clock:()=>f.now,authorizeIdentity:async()=>{},authorizeClaim:async(body:typeof q)=>({consumerId:body.subject,grantId:body.grantId,digest:body.termsHash,snapshot:{campaignId:body.campaignId,version:body.version,issuer:{ref:body.issuerRef},policy:{dailyClaim:{amount:5,timeZone:'America/Mexico_City'}}}})})
   expect((await broker().status({subject:q.subject,wallet:q.wallet,claimId:null})).state).toBe('unclaimed');expect(await f.balance()).toBe(0)
   await broker().claim(q);await algosdk.waitForConfirmation(f.algod,txId,4)
   const recovered=await broker().recover();if(recovered.length)expect(recovered[0].state).toBe('paid')
   expect((await broker().status({subject:q.subject,wallet:q.wallet,claimId:q.claimId})).state).toBe('paid');expect(await f.balance()).toBe(5)
   expect((await broker().claim({...q,claimId:randomUUID(),campaignId:randomUUID()})).claimId).toBe(q.claimId);expect(broadcasts).toBe(1);expect(await f.balance()).toBe(5)
  })
 },20000)
 test('canonical merchant eligibility, player session/CSRF, private HTTP and daily reward pair across both owners',async()=>{
  const f=await setup();await f.client.send.setAccepting({args:{accepting:true}})
  const {runDailyRewardInterop}=await import(/* @vite-ignore */ process.env.CONECTA_TEST_GAME_ROOT+'/tests/helpers/run-daily-reward-interop.mjs')
  await runDailyRewardInterop(f,process.env.CONECTA_TEST_APP_ROOT)
 },30000)
 test('first-live local acceptance daily claim binds its own network and canonical v3 participation without duplicate payout',async()=>{
  const f=await setup();await f.client.send.setAccepting({args:{accepting:true}})
  const {runDailyRewardInterop}=await import(/* @vite-ignore */ process.env.CONECTA_TEST_GAME_ROOT+'/tests/helpers/run-daily-reward-interop.mjs')
  await runDailyRewardInterop(f,process.env.CONECTA_TEST_APP_ROOT,{schema:3})
 },30000)
})
