import {beforeAll,expect,test} from 'vitest';
import {algorandFixture} from '@algorandfoundation/algokit-utils/testing';
import {microAlgos,Config} from '@algorandfoundation/algokit-utils';
import sdk from 'algosdk';
import {mkdtempSync,readFileSync,statSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {deployConecta,validateConfiguration} from './deploy.mjs';
const token='a'.repeat(64);
const fixture=algorandFixture({testAccountFunding:microAlgos(100_000_000),algodConfig:{server:'http://127.0.0.1',port:Number(process.env.CONECTA_TEST_ALGOD_PORT),token},kmdConfig:{server:'http://127.0.0.1',port:Number(process.env.CONECTA_TEST_KMD_PORT),token}});
beforeAll(async()=>{expect(Number(process.env.CONECTA_TEST_ALGOD_PORT)).toBeGreaterThan(0);expect(Number(process.env.CONECTA_TEST_KMD_PORT)).toBeGreaterThan(0);await fixture.newScope();Config.configure({debug:false});});
test('real deployment recovers lost create reply without duplicates, stays paused, and app pays all setup fees',{timeout:60000},async()=>{
 const directory=mkdtempSync(join(tmpdir(),'conecta-deploy-test-'));
 try{
  const {algod,testAccount:funding}=fixture.context,algorand=fixture.algorand,account=sdk.generateAccount();algorand.setSignerFromAccount(account);
  await algorand.send.payment({sender:funding.addr,receiver:account.addr,amount:microAlgos(10_000_000),suppressLog:true});
  const asset=await algorand.send.assetCreate({sender:account.addr,total:10000n,decimals:0,assetName:'Conecta DEPLOY LOCAL',unitName:'LOCAL'}),params=await algod.getTransactionParams().do();
  const config={schemaVersion:1,network:'localnet',algodUrl:'http://127.0.0.1/',assetId:Number(asset.assetId),operator:account.addr.toString(),treasury:account.addr.toString(),genesisId:params.genesisID,genesisHash:Buffer.from(params.genesisHash).toString('base64')};
  const journalPath=join(directory,'journal.json'),args={sdk,algod,account,config,journalPath,localAcceptance:true};
  const before=await algod.accountInformation(account.addr).do();
  await expect(deployConecta({...args,afterBroadcast:async key=>{expect(key).toBe('escrow-create');const saved=JSON.parse(readFileSync(journalPath));expect(saved.steps[key].signed).toBeTruthy();throw Error('deliberate lost creation reply');}})).rejects.toThrow('deliberate lost creation reply');
  const ready=await deployConecta(args);expect(ready.accepting).toBe(false);expect(ready.apps.escrow).not.toBe(ready.apps.daily);
  const after=await algod.accountInformation(account.addr).do();expect(after.createdApps).toHaveLength(2);expect(before.amount-after.amount).toBe(306000n);
  expect(statSync(journalPath).mode&0o077).toBe(0);expect(readFileSync(journalPath,'utf8')).not.toContain(Buffer.from(account.sk).toString('base64'));
  expect((await deployConecta(args)).apps).toEqual(ready.apps);expect((await algod.accountInformation(account.addr).do()).amount).toBe(after.amount);
  for(const action of ['accept','pause','accept'])expect((await deployConecta({...args,action})).accepting).toBe(action==='accept');
  const accepted=await algod.accountInformation(account.addr).do();expect((await deployConecta({...args,action:'accept'})).accepting).toBe(true);expect((await algod.accountInformation(account.addr).do()).amount).toBe(accepted.amount);expect(accepted.createdApps).toHaveLength(2);
  await expect(deployConecta({...args,config:{...config,treasury:sdk.generateAccount().addr.toString()}})).rejects.toThrow();
  expect(()=>validateConfiguration({...config,network:'testnet',assetId:757449774},sdk)).toThrow();
 }finally{rmSync(directory,{recursive:true,force:true});}
});
