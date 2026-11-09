# Explicit Conecta daily reward

Canonical Puya TypeScript contract for the accepted five-MGST daily claim.
Separate from game escrow: it cannot spend, change or refund any game reserve.
The trusted operator attests canonical player eligibility and an explicit claim
request; the contract checks an exact three-transaction reward group and retains
both opaque identity/day and wallet/day records to reject duplicate payouts.
MYGLOBAL must persist its intent and signed bytes before broadcasting.

The operator sends five units of the immutable zero-decimal asset directly to
the original recipient, pays network fees and sponsors 70,000 microALGO for both
retained records. The app needs its base minimum balance before claims. There is
no asset opt-in, update, delete or record-deletion method. Only the creator can
pause/unpause claims. Claim references must come from a stable private identity
namespace; names, member IDs and session data are never put in public notes.

America/Mexico_City business dates are frozen at the explicit request. Recovery
can pay an accepted older date, but never a future date. The backend's retained
claim ID prevents an uncertain request retried after midnight from claiming a
second day. The operator remains trusted for eligibility/identity attestations;
atomic grouping does not prove them or trigger a claim automatically.

Five real LocalNet cases exercise exact payments, replay/binding checks,
wrong amounts/sponsor/caller/close/rekey/extra group failures, the generated-ABI
MYGLOBAL adapter, durable PostgreSQL recovery after a lost successful reply and
the actual two-owner HTTP/session/CSRF/canonical-enrollment path.
Only random LocalNet fixture accounts/assets are used. This local implementation
is not a configured TestNet deployment or completed daily-claim browser flow.
