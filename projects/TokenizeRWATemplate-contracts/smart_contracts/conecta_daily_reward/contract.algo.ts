import {
  Account, Asset, BoxMap, Bytes, Contract, Global, GlobalState, Txn,
  abimethod, assert, assertMatch, bytes, clone, gtxn, uint64,
} from '@algorandfoundation/algorand-typescript'

export type DailyClaim = { player: Account; day: uint64; paidAt: uint64 }

// Separate from game reserves: a claim cannot spend or change an active game.
// The operator attests canonical eligibility and an explicit player request.
// Retained records make duplicate reward groups fail atomically, including
// replacement groups after the original transaction leaves pending history.
export class ConectaDailyReward extends Contract {
  mgst = GlobalState<Asset>()
  operator = GlobalState<Account>()
  accepting = GlobalState<boolean>({ initialValue: false })
  claims = BoxMap<bytes, DailyClaim>({ keyPrefix: 'c' })
  walletDays = BoxMap<{ day: uint64; player: Account }, bytes>({ keyPrefix: 'w' })

  @abimethod({ onCreate: 'require' })
  public createApplication(asset: Asset, operator: Account): void {
    assert(asset.id > 0 && asset.decimals === 0, 'integer MGST asset required')
    assert(operator !== Global.zeroAddress, 'operator required')
    this.mgst.value = asset
    this.operator.value = operator
  }

  public setAccepting(accepting: boolean): void {
    assert(Txn.sender === Global.creatorAddress, 'creator only')
    assert(Txn.rekeyTo === Global.zeroAddress, 'rekey forbidden')
    this.accepting.value = accepting
  }

  public payDaily(transfer: gtxn.AssetTransferTxn, sponsor: gtxn.PaymentTxn, player: Account, day: uint64, claimRef: bytes): void {
    assert(this.accepting.value, 'daily claims disabled')
    assert(Txn.sender === this.operator.value, 'reward operator only')
    assert(Txn.rekeyTo === Global.zeroAddress, 'rekey forbidden')
    assert(Global.groupSize === 3 && Txn.groupIndex === 2, 'exact reward group required')
    assert(transfer.groupIndex === 0 && sponsor.groupIndex === 1, 'reward order required')
    assert(player !== Global.zeroAddress && claimRef.length === 32, 'claim binding required')
    // America/Mexico_City uses UTC-6. The backend freezes the IANA business
    // date at the explicit request. An older accepted claim may recover later;
    // future dates can never be paid. No current-day auto deposit is inferred.
    assert(Global.latestTimestamp >= 21600, 'chain time invalid')
    const today: uint64 = (Global.latestTimestamp - 21600) / 86400
    assert(day > 0 && day <= today, 'business day invalid')
    assertMatch(transfer, {
      sender: this.operator.value, assetReceiver: player,
      xferAsset: this.mgst.value, assetAmount: 5,
      assetSender: Global.zeroAddress, assetCloseTo: Global.zeroAddress,
      rekeyTo: Global.zeroAddress, note: Bytes('conecta:daily:v1:').concat(claimRef),
    })
    // Covers both retained boxes (66,600 microALGO). Never billed to the player.
    assertMatch(sponsor, {
      sender: this.operator.value, receiver: Global.currentApplicationAddress,
      amount: 70000, closeRemainderTo: Global.zeroAddress, rekeyTo: Global.zeroAddress,
    })
    assert(!this.claims(claimRef).exists, 'identity already claimed')
    assert(!this.walletDays({ day, player }).exists, 'wallet already claimed')
    const record: DailyClaim = { player, day, paidAt: Global.latestTimestamp }
    this.claims(claimRef).value = clone(record)
    this.walletDays({ day, player }).value = claimRef
  }

  @abimethod({ readonly: true })
  public getClaim(claimRef: bytes): DailyClaim { return clone(this.claims(claimRef).value) }
}
