# Proposed Phase A acceptance addendum — pending owner acceptance

The historical frozen T3 acceptance matrix has not been recovered. This proposal
does not assert that delete or rename were included or excluded by that matrix.
It does not modify the production persistence contract.

Using distinct authorized and unauthorized identities against synthetic NTFS
fixture entries, attempt an unauthorized delete and an unauthorized rename as
separate cases. Before each attempt the manager verifies that the source exists;
for rename it also verifies the destination is absent. Require the actor's
access-denied result and compare protected path, type, content and security
inventory with the baseline after each attempt. Missing files, other errors,
unexpected success and changed inventory are failures. Results must retain the
actor identity binding and remain UNVERIFIED until actual hosted execution.

Formal adoption of this addendum is pending the owner's acceptance.
