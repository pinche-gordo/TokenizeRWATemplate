# Conecta paired contract deployment

This operator-only entrypoint consumes the canonical compiled ARC-56 artifacts.
It does not run from the template's generic deployment discovery or CI. Follow
the platform's complete product, migration/restore and release gates first.
Guidance: [official ARC-56 creation](https://dev.algorand.co/docs/algokit-utils/typescript/latest/concepts/building/app-client/)
and the [canonical deployment example](https://github.com/algorandfoundation/devportal-code-examples/blob/main/projects/typescript-examples/contracts/HelloWorld/deploy-config.ts).

The owner selected the existing MYGLOBAL reward hot wallet as creator, operator
and MGST treasury. It covers setup, grouped player network fees, storage,
settlement and daily-reward costs. No consumer key or consumer ALGO payment is
needed. Existing asset opt-in remains an eligibility prerequisite; this command
never opts in or funds a consumer. Setup transfers only 200,000 microALGO to the
escrow and 100,000 to the reward app. At a 1,000-microALGO minimum fee, paused
setup costs 306,000 microALGO total, plus the creator's retained minimum-balance
requirement. A two-ALGO available reserve is checked before any signed step.

Configuration is explicit JSON: `schemaVersion:1`, `network:"testnet"`,
`algodUrl:"https://testnet-api.algonode.cloud/"`, `assetId:757449774`, exact TestNet
`genesisId`/`genesisHash`, and matching `operator`/`treasury` public addresses.
No mnemonic belongs in configuration or source. The CLI reads only the existing
`MYGLOBAL_REWARD_HOT_WALLET_MNEMONIC` and checks its corresponding address.

```text
node deploy.mjs deploy-paused configuration.json private-journal.json sdk-owner-root
node deploy.mjs accept configuration.json private-journal.json sdk-owner-root
node deploy.mjs pause configuration.json private-journal.json sdk-owner-root
```

`sdk-owner-root` explicitly selects the locked application or contract SDK; no
dependency installation, network/asset fallback, automatic replacement, update
or delete occurs. Preserve the artifact-relative directory structure when
packaging this operator code. Keep the journal directory mode0700 and files0600,
outside public roots/releases. It contains signed operation bytes, never a
mnemonic. Both applications start paused; `accept` is separate and may run only
after paired runtime configuration/readiness. `pause` preserves recovery paths.

Signed bytes and transaction ID are flushed before submission. Retry the same
journal after uncertainty; confirmed creation never creates another app or pays
base funds again. If an expired transaction cannot be reconciled, stop and
investigate the recorded transaction rather than removing the journal. Program,
asset, creator, operator and treasury are checked before base funding. Public
output contains IDs, addresses and transaction IDs only.

The real owned-LocalNet regression covers a lost creation reply, exact setup
cost, no duplicate creation/funding, private journal, wrong configuration,
initial pause and repeated accept/pause/resume. It uses fresh accounts/assets
and does not read a live runtime. Production accepts pinned TestNet only; the
programmatic LocalNet option exists solely for this explicit fixture.
