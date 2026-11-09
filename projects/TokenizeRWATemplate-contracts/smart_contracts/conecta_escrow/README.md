# Conecta per-game MGST escrow

Canonical on-chain source for the accepted merchant-bound budget flow. Generated
ARC-56/client artifacts live in `smart_contracts/artifacts/conecta_escrow`; MYGLOBAL
consumes the exact ARC-56 bytes, rather than defining a competing contract ABI.
Platform contract: `myglobal.platform/docs/conecta-game-escrow-v1.md`.

The player authorizes a chosen game budget in an exact three-transaction group.
The operator's signature sponsors fees/storage and binds the whole group. Only
the operator can settle within the pinned deadline and budget/perk caps; unused
MGST returns to the original player. After the grace deadline anyone can trigger
an original-player full refund. Persistent game tombstones prevent replay.
Creator pause controls new reserves, with existing settlement/refund preserved.
There is no update/delete approval path.

Local-only implementation, not deployed to TestNet or MainNet. LocalNet cases use
fresh random keys, asset and app per case; only the test funding source is shared.
No real runtime mnemonic or database is read. The paired cases additionally need
explicit `CONECTA_TEST_APP_ROOT` and `CONECTA_TEST_GAME_ROOT` pointing to the
compatible independent worktrees and Docker for two disposable PostgreSQL DBs.

```
CONECTA_TEST_ALGOD_PORT=<owned-loopback-port> \
CONECTA_TEST_KMD_PORT=<owned-loopback-port> \
CONECTA_TEST_APP_ROOT=<compatible-app-worktree> \
CONECTA_TEST_GAME_ROOT=<compatible-game-worktree> \
node_modules/.bin/vitest run smart_contracts/conecta_escrow/contract.e2e.spec.ts --maxWorkers=1 --minWorkers=1
```

A LocalNet pass does not replace product release/CI/browser acceptance or authorize
production keys, app IDs, MGST transfers, campaign activation or prize issuance.
