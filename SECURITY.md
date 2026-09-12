# Security

Ether Memories is a local memory library, not an authentication or authorization system.

## Boundaries

- `provenance` describes origin; it is **not authentication**.
- `userId` mismatch protection prevents accidental cross-user imports; it is not access control.
- Callers are responsible for OS file permissions and secret hygiene.
- Imported JSON should be treated as untrusted input.
- `MemoryContext` may contain sensitive user memory; callers must control where it is sent.
- No provider SDK is imported by the core.
- No model is called automatically.
- No autonomous memory promotion or deletion occurs.

For deployment involving multiple users or hostile inputs, put an authenticated service boundary around the library.
