import {
  Account, Asset, BoxMap, Bytes, Contract, Global, GlobalState, Txn,
  Uint64, abimethod, assert, assertMatch, bytes, clone, gtxn, itxn, uint64,
} from '@algorandfoundation/algorand-typescript'

// Immutable per-game terms are co-signed by the operator in the reserve group.
// Hashes/references are opaque public commitments, never private identity data.
export type GameTerms = {
  gameId: bytes
  campaign: bytes
  issuer: bytes
  version: uint64
  termsHash: bytes
  rulesHash: bytes
  budget: uint64
  entryPrice: uint64
  hintPrice: uint64
  shufflePrice: uint64
  hintLimit: uint64
  shuffleLimit: uint64
  endAt: uint64
  settleBy: uint64
}
type GameReserve = {
  player: Account
  terms: GameTerms
  openedAt: uint64
  status: uint64 // 0 reserved, 1 completed, 2 lost, 3 abandoned, 4 timeout refund
  charged: uint64
  resultHash: bytes
}

export class ConectaEscrow extends Contract {
  mgst = GlobalState<Asset>()
  operator = GlobalState<Account>()
  treasury = GlobalState<Account>()
  accepting = GlobalState<boolean>({ initialValue: false })
  optedIn = GlobalState<boolean>({ initialValue: false })
  games = BoxMap<bytes, GameReserve>({ keyPrefix: 'g' })

  @abimethod({ onCreate: 'require' })
  public createApplication(asset: Asset, operator: Account, treasury: Account): void {
    assert(asset.id > 0 && asset.decimals === 0, 'integer MGST asset required')
    assert(operator !== Global.zeroAddress && treasury !== Global.zeroAddress, 'accounts required')
    this.mgst.value = asset
    this.operator.value = operator
    this.treasury.value = treasury
  }

  public optInAsset(): void {
    assert(Txn.sender === Global.creatorAddress, 'creator only')
    assert(!this.optedIn.value, 'already opted in')
    itxn.assetTransfer({ xferAsset: this.mgst.value, assetReceiver: Global.currentApplicationAddress, assetAmount: 0, fee: 0 }).submit()
    this.optedIn.value = true
  }

  public setAccepting(accepting: boolean): void {
    assert(Txn.sender === Global.creatorAddress, 'creator only')
    assert(this.optedIn.value, 'asset opt in required')
    this.accepting.value = accepting
  }

  public reserve(transfer: gtxn.AssetTransferTxn, sponsor: gtxn.PaymentTxn, terms: GameTerms): void {
    assert(this.accepting.value, 'new games disabled')
    assert(Global.groupSize === 3 && Txn.groupIndex === 2, 'exact reserve group required')
    assert(transfer.groupIndex === 0 && sponsor.groupIndex === 1, 'reserve order required')
    assert(Txn.rekeyTo === Global.zeroAddress, 'rekey forbidden')
    assertMatch(transfer, {
      sender: Txn.sender, assetReceiver: Global.currentApplicationAddress,
      xferAsset: this.mgst.value, assetAmount: terms.budget,
      assetSender: Global.zeroAddress, assetCloseTo: Global.zeroAddress, rekeyTo: Global.zeroAddress,
    })
    // The operator pays box storage funding; player pays only the approved MGST.
    // Its signature binds every member of this exact group, including all terms.
    assertMatch(sponsor, {
      sender: this.operator.value, receiver: Global.currentApplicationAddress,
      amount: Uint64(250000), closeRemainderTo: Global.zeroAddress, rekeyTo: Global.zeroAddress,
    })
    assert(terms.gameId.length === 32 && terms.campaign.length === 32 && terms.issuer.length === 32, 'reference lengths')
    assert(terms.termsHash.length === 32 && terms.rulesHash.length === 32 && terms.version > 0, 'versioned commitments required')
    assert(!this.games(terms.gameId).exists, 'game already reserved')
    assert(terms.entryPrice >= 1 && terms.entryPrice <= 5, 'entry bounds')
    assert(terms.hintPrice >= 1 && terms.hintPrice <= 5, 'hint bounds')
    assert(terms.shufflePrice >= 1 && terms.shufflePrice <= 5, 'shuffle bounds')
    assert(terms.hintLimit <= 2 && terms.shuffleLimit <= 1, 'whole game caps')
    const maximum: uint64 = terms.entryPrice + terms.hintPrice * terms.hintLimit + terms.shufflePrice * terms.shuffleLimit
    assert(terms.budget >= terms.entryPrice && terms.budget <= maximum, 'budget bounds')
    assert(terms.endAt > Global.latestTimestamp && terms.endAt <= Global.latestTimestamp + 3600, 'game deadline bounds')
    assert(terms.settleBy > terms.endAt && terms.settleBy <= terms.endAt + 900, 'settlement grace bounds')
    const game: GameReserve = { player: Txn.sender, terms: clone(terms), openedAt: Global.latestTimestamp, status: 0, charged: 0, resultHash: Bytes('') }
    this.games(terms.gameId).value = clone(game)
  }

  public settle(gameId: bytes, hints: uint64, shuffles: uint64, completedAt: uint64, status: uint64, resultHash: bytes): uint64 {
    assert(Txn.sender === this.operator.value, 'settlement operator only')
    assert(Txn.rekeyTo === Global.zeroAddress, 'rekey forbidden')
    const game = clone(this.games(gameId).value)
    assert(game.status === 0, 'game already finalized')
    assert(Global.latestTimestamp <= game.terms.settleBy, 'settlement deadline passed')
    assert(status >= 1 && status <= 3, 'terminal outcome required')
    assert(completedAt >= game.openedAt && completedAt <= Global.latestTimestamp, 'completion timestamp invalid')
    if (status !== 3) assert(completedAt < game.terms.endAt, 'game finished after close')
    assert(hints <= game.terms.hintLimit && shuffles <= game.terms.shuffleLimit, 'whole game caps')
    assert(resultHash.length === 32, 'result commitment required')
    const charge: uint64 = game.terms.entryPrice + hints * game.terms.hintPrice + shuffles * game.terms.shufflePrice
    assert(charge <= game.terms.budget, 'charge exceeds player budget')
    game.status = status
    game.charged = charge
    game.resultHash = resultHash
    this.games(gameId).value = clone(game)
    this.sendAsset(this.treasury.value, charge, gameId.concat(resultHash))
    const refund: uint64 = game.terms.budget - charge
    if (refund > 0) this.sendAsset(game.player, refund, gameId.concat(resultHash))
    return charge
  }

  // Anyone can recover a stalled reserve after the published deadline. Funds go
  // only to its original player. A timeout refund carries no prize entitlement.
  public refundTimedOut(gameId: bytes): uint64 {
    const game = clone(this.games(gameId).value)
    assert(game.status === 0, 'game already finalized')
    assert(Global.latestTimestamp > game.terms.settleBy, 'refund not yet available')
    game.status = 4
    this.games(gameId).value = clone(game)
    this.sendAsset(game.player, game.terms.budget, gameId)
    return game.terms.budget
  }

  @abimethod({ readonly: true })
  public getGame(gameId: bytes): GameReserve { return clone(this.games(gameId).value) }

  private sendAsset(receiver: Account, amount: uint64, commitment: bytes): void {
    itxn.assetTransfer({ xferAsset: this.mgst.value, assetReceiver: receiver, assetAmount: amount, fee: 0, note: Bytes('conecta:receipt:v1:').concat(commitment) }).submit()
  }
}
