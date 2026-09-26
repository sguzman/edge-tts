# Piper text normalization and pronunciation layer

## Status

Design only. Do not enable pronunciation rewriting until source-to-spoken
mapping tests exist.

## Goal

Allow the Linux Piper backend to rewrite text for pronunciation without
mutating page text, reader cursor state, click-to-seek coordinates, or
highlight provenance.

The computational cost of this layer is negligible compared with ONNX
inference. The hard part is preserving the relationship between what the user
sees and what Piper hears.

## Core invariant

The readable page model remains canonical.

```text
DOM/source text
  -> canonical reader segments
  -> pronunciation/normalization projection
  -> Piper spoken text
```

Never replace canonical segment text with normalized speech text.

Each synthesized payload must retain a projection from spoken character ranges
back to one or more canonical reader segments. Highlighting and seeking always
operate on canonical segments.

## Recommended v1 rule classes

Keep the passes explicit and ordered rather than hiding them inside one regex
bucket:

1. literal/brand pronunciation map
2. abbreviation map
3. acronym expansion
4. year/number pronunciation rules
5. narrowly-scoped lexical exceptions

Rules should be locale-aware and eventually voice-aware.

## Safe token-local implementation

The current reader already synthesizes from token-like source segments. A
low-risk first version can attach `spokenText` to each canonical segment:

```text
segment.text       = "GPU"
segment.spokenText = "G P U"
```

The payload builder concatenates `spokenText` for Piper but stores spoken
start offsets for the original canonical segment. Multiple spoken words may
therefore highlight the same visible token, which is correct and preserves
click-to-seek.

## Phrase rules

Multi-token phrase rewrites require an explicit span projection rather than
destructive replacement. A rule such as:

```text
"Open AI" -> "Open A I"
```

must retain the canonical source span covering both original tokens.

Do not introduce phrase rules until the projection type can represent
one-spoken-span -> many-source-segments.

## Provenance

A transformed payload should be inspectable. For every applied rule retain at
least:

- rule id
- rule class
- source span
- source text
- spoken text
- locale
- optional voice scope

This allows pronunciation bugs to be audited without guessing which pass
changed the sentence.

## Interaction with timing

The current Piper v1 word timing is approximate. Pronunciation rewriting must
not make it worse by pretending spoken character offsets are source offsets.
Boundary mapping must use the spoken-to-canonical projection created during
normalization.

This architecture is compatible with future true Piper phoneme/sample
alignment because the phoneme timeline can still resolve through the same
spoken-to-canonical projection.

## Performance

Normalization should run only for material being sent to Piper, not across the
whole page in the background. Ordered maps and small regex/rule passes over one
sentence are trivial compared with CPU ONNX synthesis and do not justify a
background worker or service.
