# Visual verification

`noop visual` keeps GUI evidence for one named session under `~/.noop/visual/<name>/`. A candidate receipt is written only after the same session proves target authorization, a running process, a visible window, capture capability, and a successful GUI action.

```sh
noop visual verify pilot-001c
noop visual receipt pilot-001c \
  --target "Teacher Doc Studio" \
  --candidate-commit "$CANDIDATE_COMMIT" \
  --candidate-tree "$CANDIDATE_TREE" \
  --candidate-binary-sha256 "$BINARY_SHA256" \
  --candidate-archive-sha256 "$ARCHIVE_SHA256" \
  --output "$RECEIPT"
noop visual stop pilot-001c
```

Both `verify` and `receipt` exit `42` when evidence is incomplete. `receipt` also rejects malformed candidate identities, a target mismatch, an unavailable verifier Git identity, or an existing output path. It never overwrites an earlier receipt.

The receipt binds the candidate commit, tree, signed binary hash and archive hash to the exact target authorization, observed processes and window, capture state, latest successful GUI action, verifier commit/tree/source hashes, and final verification checks. It supplements rather than replaces task-specific manual acceptance evidence.
