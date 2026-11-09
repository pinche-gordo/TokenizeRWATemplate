import { Config } from '@algorandfoundation/algokit-utils'
import { algorandFixture } from '@algorandfoundation/algokit-utils/testing'
import { microAlgos } from '@algorandfoundation/algokit-utils'
import { randomBytes, randomUUID } from 'node:crypto'
import algosdk from 'algosdk'
import { beforeAll, beforeEach, describe, expect, test } from 'vitest'
import { ConectaEscrowFactory, GameTerms, GameReserve } from '../artifacts/conecta_escrow/ConectaEscrowClient'
import { ConectaDailyRewardFactory } from '../artifacts/conecta_daily_reward/ConectaDailyRewardClient'

const token='a'.repeat(64)
const localnet=algorandFixture({
  testAccountFunding:microAlgos(1_000_000_000),
  algodConfig:{server:'http://127.0.0.1',port:Number(process.env.CONECTA_TEST_ALGOD_PORT),token},
  kmdConfig:{server:'http://127.0.0.1',port:Number(process.env.CONECTA_TEST_KMD_PORT),token},
})
const hash=()=>new Uint8Array(randomBytes(32))

describe('Conecta escrow real LocalNet',()=>{
  beforeAll(async()=>{expect(Number(process.env.CONECTA_TEST_ALGOD_PORT)).toBeGreaterThan(0);expect(Number(process.env.CONECTA_TEST_KMD_PORT)).toBeGreaterThan(0);await localnet.newScope();Config.configure({debug:false})})
  beforeEach(()=>Config.configure({debug:false}))
  async function setup(){
    // Share only the LocalNet funding source. Each case still creates fresh
    // random player/operator/outsider keys, a fresh asset and a fresh app. Avoid
    // repeated KMD test-wallet derivation as its persistent key list grows.
    const {testAccount:creator,algod}=localnet.context,algorand=localnet.algorand
    const generateAccount=async({initialFunds}:{initialFunds:ReturnType<typeof microAlgos>;suppressLog:boolean})=>{
      const account=algosdk.generateAccount();algorand.setSignerFromAccount(account)
      await algorand.send.payment({sender:creator.addr,receiver:account.addr,amount:initialFunds,suppressLog:true})
      return account
    }
    const operator=await generateAccount({initialFunds:microAlgos(10_000_000),suppressLog:true})
    const player=await generateAccount({initialFunds:microAlgos(10_000_000),suppressLog:true})
    const outsider=await generateAccount({initialFunds:microAlgos(10_000_000),suppressLog:true})
    const asset=await algorand.send.assetCreate({sender:creator.addr,total:10000n,decimals:0,assetName:'Conecta LOCAL TEST',unitName:'LOCAL'})
    for(const account of [operator,player,outsider])await algorand.send.assetOptIn({sender:account.addr,assetId:asset.assetId})
    await algorand.send.assetTransfer({sender:creator.addr,receiver:player.addr,assetId:asset.assetId,amount:100n})
    const factory=algorand.client.getTypedAppFactory(ConectaEscrowFactory,{defaultSender:creator.addr})
    const {appClient:client}=await factory.send.create.createApplication({args:{asset:asset.assetId,operator:operator.addr.toString(),treasury:creator.addr.toString()}})
    await algorand.send.payment({sender:creator.addr,receiver:client.appAddress,amount:microAlgos(1_000_000)})
    await client.send.optInAsset({args:{},extraFee:microAlgos(1000)})
    await client.send.setAccepting({args:{accepting:true}})
    const status=await algod.status().do(),block=await algod.block(status.lastRound).do(),now=block.block.header.timestamp
    const terms:GameTerms={gameId:hash(),campaign:hash(),issuer:hash(),version:1n,termsHash:hash(),rulesHash:hash(),budget:4n,entryPrice:1n,hintPrice:1n,shufflePrice:1n,hintLimit:2n,shuffleLimit:1n,endAt:now+300n,settleBy:now+600n}
    const reserve=async(t:GameTerms=terms,sponsorAccount=operator)=>{
      const transfer=await algorand.createTransaction.assetTransfer({sender:player.addr,receiver:client.appAddress,assetId:asset.assetId,amount:t.budget})
      const sponsor=await algorand.createTransaction.payment({sender:sponsorAccount.addr,receiver:client.appAddress,amount:microAlgos(250000)})
      return client.send.reserve({sender:player.addr,args:{transfer,sponsor,terms:t}})
    }
    const game=async()=>await client.getGame({args:{gameId:terms.gameId}}) as GameReserve
    const balance=async(address=player.addr)=>Number((await algod.accountAssetInformation(address,asset.assetId).do()).assetHolding!.amount)
    const settle=async(patch:Partial<{hints:bigint;shuffles:bigint;completedAt:bigint;status:bigint;resultHash:Uint8Array}>={},sender=operator)=>{
      const g=await game()
      return client.send.settle({sender:sender.addr,extraFee:microAlgos(2000),args:{gameId:terms.gameId,hints:1n,shuffles:0n,completedAt:g.openedAt,status:1n,resultHash:hash(),...patch}})
    }
    return {creator,operator,player,outsider,asset,client,algod,algorand,terms,reserve,game,balance,settle}
  }
  test('player-approved4 reserve charges2 and returns2 with public result commitments',async()=>{
    const f=await setup();await f.reserve();expect(await f.balance()).toBe(96)
    const commitment=hash(),result=await f.settle({resultHash:commitment});expect(result.return).toBe(2n);expect(await f.balance()).toBe(98)
    const game=await f.game();expect(game.status).toBe(1n);expect(game.charged).toBe(2n);expect(game.terms.campaign).toEqual(f.terms.campaign);expect(game.resultHash).toEqual(commitment)
    const inner=result.confirmation.innerTxns!;expect(inner).toHaveLength(2)
    for(const txn of inner)expect(Buffer.from(txn.txn.txn.note).subarray(0,19).toString()).toBe('conecta:receipt:v1:')
    await expect(f.settle()).rejects.toThrow();expect(await f.balance()).toBe(98)
  })
  test('wrong settlement signer and wrong reserve sponsor cannot move a player reserve',async()=>{
    const f=await setup();await expect(f.reserve(f.terms,f.outsider)).rejects.toThrow();expect(await f.balance()).toBe(100)
    await f.reserve();await expect(f.settle({},f.outsider)).rejects.toThrow();expect(await f.balance()).toBe(96)
  })
  test('contract rejects out-of-bounds prices, caps, budget and reused game references',async()=>{
    const f=await setup()
    for(const patch of [{entryPrice:0n},{hintPrice:6n},{hintLimit:3n},{shuffleLimit:2n},{budget:5n},{budget:0n}])await expect(f.reserve({...f.terms,...patch})).rejects.toThrow()
    expect(await f.balance()).toBe(100);await f.reserve();await expect(f.reserve()).rejects.toThrow();expect(await f.balance()).toBe(96)
  })
  test('accepted reserve enforces remaining budget and caps at settlement',async()=>{
    const f=await setup();f.terms.budget=1n;await f.reserve()
    await expect(f.settle()).rejects.toThrow();await expect(f.settle({hints:3n})).rejects.toThrow()
    await f.settle({hints:0n,shuffles:0n,status:2n});expect(await f.balance()).toBe(99)
  })
  test('pause blocks new reserves but retains funded settlement and rejects unauthorized unpause',async()=>{
    const f=await setup();await f.reserve();await f.client.send.setAccepting({args:{accepting:false}})
    await expect(f.reserve({...f.terms,gameId:hash()})).rejects.toThrow()
    await expect(f.client.send.setAccepting({sender:f.outsider.addr,args:{accepting:true}})).rejects.toThrow()
    await f.settle({status:3n});expect(await f.balance()).toBe(98)
  })
  test('missing result commitment and invalid completion time cannot finalize',async()=>{
    const f=await setup();await f.reserve()
    await expect(f.settle({resultHash:new Uint8Array()})).rejects.toThrow()
    await expect(f.settle({completedAt:f.terms.endAt})).rejects.toThrow()
    await expect(f.client.send.refundTimedOut({args:{gameId:f.terms.gameId},extraFee:microAlgos(1000)})).rejects.toThrow()
    expect((await f.game()).status).toBe(0n)
  })
  test('real app adapter binds canonical artifact, merchant and exact independently signed group',async()=>{
    const f=await setup()
    const module=await import(/* @vite-ignore */ process.env.CONECTA_TEST_APP_ROOT+'/src/server/conecta-game-escrow.js')
    const params=await f.algod.getTransactionParams().do()
    const adapter=module.createGameEscrowAdapter({algod:f.algod,appId:Number(f.client.appId),assetId:Number(f.asset.assetId),operator:f.operator.addr.toString(),treasury:f.creator.addr.toString(),genesisHash:Buffer.from(params.genesisHash!).toString('base64'),signOperator:(txn:algosdk.Transaction)=>txn.signTxn(f.operator.sk)})
    expect((await adapter.readiness()).ready).toBe(true)
    const c={gameId:randomUUID(),campaignId:randomUUID(),issuerRef:randomUUID(),version:1,termsHash:Buffer.from(hash()).toString('hex'),rulesHash:Buffer.from(hash()).toString('hex'),wallet:f.player.addr.toString(),budget:4,prices:{entry:1,hint:1,shuffle:1},limits:{hints:2,shuffles:1},endAt:Number(f.terms.endAt),settleBy:Number(f.terms.settleBy)}
    const plan=await adapter.prepareReserve(c)
    const signatures=[0,2].map(i=>Buffer.from(algosdk.decodeUnsignedTransaction(Buffer.from(plan.transactions[i],'base64')).signTxn(f.player.sk)).toString('base64'))
    const forged=[...signatures];forged[0]=Buffer.from(algosdk.decodeUnsignedTransaction(Buffer.from(plan.transactions[0],'base64')).signTxn(f.outsider.sk)).toString('base64')
    expect(()=>adapter.assembleReserve(plan,forged)).toThrow()
    await adapter.broadcast(adapter.assembleReserve(plan,signatures));await algosdk.waitForConfirmation(f.algod,plan.txId,4)
    const game=await adapter.confirmedGame(c);expect(game.status).toBe(0);expect(await f.balance()).toBe(96)
    await expect(adapter.confirmedGame({...c,campaignId:randomUUID()})).rejects.toThrow()
    await expect(adapter.confirmedGame({...c,issuerRef:randomUUID()})).rejects.toThrow()
    const settlement=await adapter.prepareSettlement(c,{hints:1,shuffles:0,completedAt:game.openedAt,status:1,resultHash:Buffer.from(hash()).toString('hex')})
    await adapter.broadcast(settlement);await algosdk.waitForConfirmation(f.algod,settlement.txId,4)
    expect(await f.balance()).toBe(98);expect((await adapter.confirmedGame(c)).charged).toBe(2)
    await expect(adapter.prepareSettlement(c,{hints:1,shuffles:0,completedAt:game.openedAt,status:1,resultHash:Buffer.from(hash()).toString('hex')})).rejects.toThrow()
  })
  test('durable MYGLOBAL broker and actual chain reconcile lost reserve/settlement replies',async()=>{
    const f=await setup(),root=process.env.CONECTA_TEST_APP_ROOT
    const {createGameEscrowAdapter}=await import(/* @vite-ignore */ root+'/src/server/conecta-game-escrow.js')
    const {createEscrowBroker}=await import(/* @vite-ignore */ root+'/src/server/conecta-escrow-broker.js')
    const {withCampaignPostgres}=await import(/* @vite-ignore */ root+'/tests/helpers/conecta-prize-postgres.mjs')
    const {readFileSync}=await import('node:fs')
    await withCampaignPostgres(async(newPool:()=>{query:(sql:string,args?:unknown[])=>Promise<{rows:{signed_reserve:{blobs:string[]},signed_settlement:{blobs:string[]},completion:unknown}[]}>})=>{
      const pool=newPool();await pool.query(readFileSync(root+'/db/sql/migrations/2026-11-08_conecta_game_escrow.sql','utf8'))
      const params=await f.algod.getTransactionParams().do()
      const chain=createGameEscrowAdapter({algod:f.algod,appId:Number(f.client.appId),assetId:Number(f.asset.assetId),operator:f.operator.addr.toString(),treasury:f.creator.addr.toString(),genesisHash:Buffer.from(params.genesisHash!).toString('base64'),signOperator:(txn:algosdk.Transaction)=>txn.signTxn(f.operator.sk)})
      const now=Number(f.terms.endAt-300n)*1000,campaignId=randomUUID(),issuerRef=randomUUID(),grantId=randomUUID(),termsHash=Buffer.from(hash()).toString('hex')
      const snapshot={campaignId,version:1,issuer:{ref:issuerRef},effective:{entryPrice:1,hintPrice:1,shufflePrice:1,hintLimit:2,shuffleLimit:1,gameLimit:10,globalGameLimit:10},config:{endAt:new Date(Number(f.terms.endAt)*1000).toISOString()},policy:{rules:{hash:Buffer.from(hash()).toString('hex'),levelCount:3}}}
      const adapter={...chain,async broadcast(signed:{txId:string;gameId?:string}){
        const row=(await pool.query('SELECT * FROM conecta_game_escrow.games WHERE reserve_plan->>\'txId\'=$1 OR game_id::text=$2',[signed.txId,signed.gameId||null])).rows[0]
        expect(row.signed_reserve||row.signed_settlement).toBeTruthy()
        await chain.broadcast(signed);await algosdk.waitForConfirmation(f.algod,signed.txId,4)
        throw Error('Deliberate lost network reply after confirmation')
      }}
      const service=()=>createEscrowBroker({pool,adapter,authorizeReserve:async()=>({snapshot,digest:termsHash,grantId}),enabled:true,clock:()=>now})
      const quote=await service().quote({gameId:randomUUID(),subject:'1',wallet:f.player.addr.toString(),campaignId,version:1,issuerRef,termsHash,grantId,budget:4})
      const identity={gameId:quote.gameId,subject:'1',wallet:f.player.addr.toString()}
      const signatures=[0,2].map(i=>Buffer.from(algosdk.decodeUnsignedTransaction(Buffer.from(quote.reservePlan.transactions[i],'base64')).signTxn(f.player.sk)).toString('base64'))
      expect((await service().submit({...identity,signatures})).state).toBe('funded');expect(await f.balance()).toBe(96)
      const funded=await service().read(identity),completedAt=funded.receipt.openedAt*1000
      const completion={outcome:'lost',hintsUsed:1,shufflesUsed:0,completedAt,score:300,levels:[{level:0,score:300,outcome:'lost',completedAt}]}
      const settled=await service().finish({...identity,completion});expect(settled.state).toBe('settled');expect(settled.receipt.charged).toBe(2);expect(await f.balance()).toBe(98)
      expect((await service().finish({...identity,completion})).state).toBe('settled');expect(await f.balance()).toBe(98)
      const audit=(await pool.query('SELECT signed_reserve,signed_settlement,completion FROM conecta_game_escrow.games WHERE game_id=$1',[quote.gameId])).rows[0]
      expect(audit.completion).toEqual(completion);expect(audit.signed_reserve.blobs).toHaveLength(3);expect(audit.signed_settlement.blobs).toHaveLength(1)
    })
  },30000)
  test('merchant enrollment, signed private HTTP, funded game, three levels and actual MGST settlement pair end to end',async()=>{
    const f=await setup()
    const {runFundedEscrowInterop}=await import(/* @vite-ignore */ process.env.CONECTA_TEST_GAME_ROOT+'/tests/helpers/run-funded-escrow-interop.mjs')
    await runFundedEscrowInterop(f,process.env.CONECTA_TEST_APP_ROOT)
  },30000)
  test('anyone can trigger overdue refund only to original player; replay and late settlement fail',async()=>{
    const f=await setup();await f.reserve();await f.algod.setBlockOffsetTimestamp(1000).do()
    try{
      // Produce the next developer-network block after changing its timestamp.
      await f.algorand.send.payment({sender:f.creator.addr,receiver:f.creator.addr,amount:microAlgos(0)})
      const result=await f.client.send.refundTimedOut({sender:f.outsider.addr,args:{gameId:f.terms.gameId},extraFee:microAlgos(1000)})
      expect(result.return).toBe(4n);expect(await f.balance()).toBe(100);expect((await f.game()).status).toBe(4n)
      await expect(f.settle()).rejects.toThrow();await expect(f.client.send.refundTimedOut({args:{gameId:f.terms.gameId},extraFee:microAlgos(1000)})).rejects.toThrow()
    }finally{await f.algod.setBlockOffsetTimestamp(0).do()}
  })
  test('actual adapter timeout refund recovers the original wallet once after operator outage',async()=>{
    const f=await setup()
    const module=await import(/* @vite-ignore */ process.env.CONECTA_TEST_APP_ROOT+'/src/server/conecta-game-escrow.js')
    const params=await f.algod.getTransactionParams().do(),adapter=module.createGameEscrowAdapter({algod:f.algod,appId:Number(f.client.appId),assetId:Number(f.asset.assetId),operator:f.operator.addr.toString(),treasury:f.creator.addr.toString(),genesisHash:Buffer.from(params.genesisHash!).toString('base64'),signOperator:(txn:algosdk.Transaction)=>txn.signTxn(f.operator.sk)})
    const now=await adapter.chainTimestamp(),c={gameId:randomUUID(),campaignId:randomUUID(),issuerRef:randomUUID(),version:1,termsHash:Buffer.from(hash()).toString('hex'),rulesHash:Buffer.from(hash()).toString('hex'),wallet:f.player.addr.toString(),budget:4,prices:{entry:1,hint:1,shuffle:1},limits:{hints:2,shuffles:1},endAt:now+300,settleBy:now+600}
    const plan=await adapter.prepareReserve(c),signatures=[0,2].map(i=>Buffer.from(algosdk.decodeUnsignedTransaction(Buffer.from(plan.transactions[i],'base64')).signTxn(f.player.sk)).toString('base64'))
    await adapter.broadcast(adapter.assembleReserve(plan,signatures));await algosdk.waitForConfirmation(f.algod,plan.txId,4);expect(await f.balance()).toBe(96)
    // The default Contract lifecycle has no update/delete approval path.
    await expect(f.algorand.send.appDelete({sender:f.creator.addr,appId:f.client.appId})).rejects.toThrow();expect(await f.balance()).toBe(96)
    const offset=Math.max(0,now-Math.floor(Date.now()/1000))+1000
    await f.algod.setBlockOffsetTimestamp(offset).do()
    try{
      await f.algorand.send.payment({sender:f.creator.addr,receiver:f.creator.addr,amount:microAlgos(0)})
      const refund=await adapter.prepareTimeoutRefund(c);await adapter.broadcast(refund);await algosdk.waitForConfirmation(f.algod,refund.txId,4)
      expect(await f.balance()).toBe(100);expect((await adapter.confirmedGame(c)).status).toBe(4)
      await expect(adapter.prepareTimeoutRefund(c)).rejects.toThrow();expect(await f.balance()).toBe(100)
    }finally{await f.algod.setBlockOffsetTimestamp(0).do()}
  })

  test('approved wallet drawer works in bilingual mobile/desktop with real LocalNet checkout and preserved free play',async()=>{
    const f=await setup()
    const factory=f.algorand.client.getTypedAppFactory(ConectaDailyRewardFactory,{defaultSender:f.creator.addr})
    const {appClient:dailyClient}=await factory.send.create.createApplication({args:{asset:f.asset.assetId,operator:f.operator.addr.toString()}})
    await f.algorand.send.payment({sender:f.creator.addr,receiver:dailyClient.appAddress,amount:microAlgos(100000)})
    await f.algorand.send.assetTransfer({sender:f.creator.addr,receiver:f.operator.addr,assetId:f.asset.assetId,amount:20n})
    await dailyClient.send.setAccepting({args:{accepting:true}})
    const {runConectaWalletBrowser}=await import(/* @vite-ignore */ process.env.CONECTA_TEST_APP_ROOT+'/tests/helpers/run-conecta-wallet-browser.mjs')
    await runConectaWalletBrowser({...f,dailyClient},process.env.CONECTA_TEST_APP_ROOT,process.env.CONECTA_TEST_GAME_ROOT)
  },120000)
  test('separately versioned first-live local acceptance binds network, canonical merchant, all levels and actual settlement',async()=>{
    const f=await setup()
    const {runFundedEscrowInterop}=await import(/* @vite-ignore */ process.env.CONECTA_TEST_GAME_ROOT+'/tests/helpers/run-funded-escrow-interop.mjs')
    await runFundedEscrowInterop(f,process.env.CONECTA_TEST_APP_ROOT,{schema:3})
  },30000)

})
