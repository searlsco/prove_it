# Definition of Done

Work is done when it has been independently verified — not when you believe
it works, but when you can prove it works. These rules define what "done"
means for this project.

## Rules

- **Verified, not assumed.** Every claim of completion must be backed by
  evidence: a passing test, a working demo, a confirmed output. If you
  can't show it working, it isn't done.
- **Tests prove behavior changed.** New behavior needs a test that fails
  without the change and passes with it. A test that passes either way
  proves nothing.
- **The consumer agrees.** If your code produces output consumed by another
  system, "done" means the consumer handles it correctly — not just that
  your code runs without errors.
- **Error paths are exercised.** Happy-path-only verification is incomplete.
  Done means you've confirmed what happens when inputs are wrong, services
  are down, or state is unexpected.
- **Smooth beats fast.** Rushing to "done" creates rework. Small, verified
  increments compound into reliable progress. Big leaps create big risks.
- **Clean working tree.** No uncommitted debug code, no TODO hacks, no
  commented-out blocks left behind.
- **Documentation matches reality.** If behavior changed, any docs, comments,
  or README sections that reference it are updated.

<!-- TODO: Customize these rules for your project -->
