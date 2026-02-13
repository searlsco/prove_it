# Testing Rules

Every feature and bug fix must be thoroughly covered by automated tests
that verify correctness without human intervention.

Your work will be evaluated at each review checkpoint (before tool use,
after each turn, and before each commit) against this standard:

- New behavior requires new tests that would fail if the code were reverted
- Bug fixes require regression tests that reproduce the original failure
- "Hard to test" is not a valid exemption — if it runs, it can be tested

<!-- TODO: Customize these rules for your project -->
