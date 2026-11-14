# Proposed inner-job acceptance clarification v1

Status: PROPOSED, owner adoption pending. This does not amend or recover the
historical frozen T3 contract.

The bounded job-closure observation consists of a live, identity-bound child;
manager inspection of the supervisor-reported inner job with the expected limit
and child membership; checked release of the manager's query handle; a close
request; the reviewed supervisor's successful exit after its close-and-wait
path; an independent signaled child wait and non-active exit state; and confirmed
cleanup. A supervisor-death observation is separate and is not a reported close.

This sequence shows ordered observations under the controlled launcher and
handle-ownership protocol. It does not prove that no other job handle existed
anywhere in Windows, that the supervisor-reported handle is globally unique, or
that closure caused the child's exit instead of a concurrent independent event.
A timeout, failed wait, pre-trigger exit, missing observation, or unconfirmed
cleanup cannot satisfy the successful sequence. A positively observed survivor
is retained as a control failure; absent authorization, provenance or cleanup,
the final result remains UNVERIFIED. Injected and same-identity outcomes are
not live cross-identity acceptance evidence.

Owner decision needed: whether this bounded sequence is sufficient for the
provisional jobClosure acceptance control. The source adapter is provisional;
no freeze or historical scope decision follows from it.
