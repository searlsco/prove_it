# prove_it Harness-Neutral Clean Redesign Policy Defaults

> Resolves GitHub issue #2: Decide redesign public policy defaults.  
> Source brief: `plans/prove-it-harness-neutral-clean-redesign-brief.md`  
> Updated after HITL clarification: Pi-first clean-room implementation, no legacy runtime compatibility, no user-only signal mode.

## Decision summary

| Policy area | Decision |
| --- | --- |
| Launch adapter order | Pi first, Claude fast-follow, Codex deferred. |
| Agent-owned completion | Agent-initiated `done` remains mandatory after each coherent coding task. |
| User-only signals | No user-only signal authority mode in this redesign scope. Users may inspect/administer state, but agent-owned accountability is the product contract. |
| Legacy compatibility | No legacy runtime compatibility in the clean redesign. The new runtime reads strict `.prove_it` config only. Existing Claude implementation is a comparison/reference, not a compatibility substrate. |
| Pi enforcement model | Pi is first-class, not experimental. Its completion enforcement profile is remediation-based after `agent_end` until a hard Stop blocker exists. |
| Capability reporting | Use capability/enforcement profiles, not broad experimental labels. Support tiers can be reconsidered later. |
| Evidence/proving | Evidence-oriented proving is core methodology. A literal `/prove` command name is adapter/distribution UX, not a core primitive. |
| TDD | TDD is the default methodology profile, not a universal core invariant. |
| Phase | Phase state is out of scope for the Pi-first MVP. Reconsider later if the TDD profile needs it. |
| Reviewers | Reviewers use the active harness only in this redesign scope. Cross-harness reviewers are future work. |
| Human review | Human review is downstream/external, not a core prove_it gate. |
| Next implementation target | After policy/issue cleanup, build a minimal Pi pre-tool config-guard vertical slice. |
| Pi package identity | Working package identity is `@davemo/pi-prove-it`; adapter id is `pi`; display name is `Pi`. |

## Detailed decisions

### 1. Pi first, Claude fast-follow, Codex deferred

The clean redesign should prove the methodology and adapter contract through Pi first. Pi is the harness this effort cares about most, and using it first prevents the new architecture from becoming “Claude hooks generalized.”

Launch scope:

1. Build the core methodology/config/workflow engine from first principles.
2. Implement Pi as the first proving-ground adapter.
3. Implement Claude as a fast-follow adapter using the same contract.
4. Defer Codex until Pi and Claude stabilize.

The existing Claude implementation remains valuable as a behavioral comparison oracle, but it is not the architecture source of truth and not a compatibility substrate.

### 2. Agent-owned `done` remains mandatory

The redesign default is agent-accountability mode: the primary agent must declare `done` when it believes a coherent coding task is complete and ready for full verification. That declaration is the transition from normal work into completion verification.

This remains mandatory because it is the product's central behavioral contract: prove_it makes consequential agent claims accountable. If an agent can finish work and merely claim completion in prose without setting a signal, the verification workflow becomes advisory rather than supervisory.

Boundaries:

- `done` is required after a coherent task, not after every edit, file, or test command.
- The agent should use `stuck` when blocked or looping.
- The agent should use `idle` when between tasks or when no completion claim is being made.
- The agent must avoid completion language unless it has declared `done` and the resulting verification has passed.

### 3. No user-only signal authority mode in this redesign

The clean redesign should not include a mode where only the user may set completion signals. That mode does not exist in the current product, adds scope, and works against the goal of maximal agent autonomy with accountability.

Users may still have adapter-native admin/debug controls to inspect, clear, or override state. Those controls are not a separate product mode and should not change the default expectation that agents own accountability signals.

### 4. No legacy runtime compatibility

The new public config model should be strict, workflow-first, and rooted in `.prove_it`. It should not accept legacy `.claude/prove_it` hook-shaped config as an equivalent runtime shape.

Clean redesign behavior:

- `.prove_it/config.json` uses the new schema only.
- Unknown fields and legacy hook-shaped fields are hard validation errors in the new schema.
- The new runtime does not compile legacy config, merge legacy config, or silently bridge to legacy behavior.
- Generated examples and docs teach the new workflow-first shape.

Migration guidance or tooling may exist outside the runtime, but dual runtime semantics are out of scope.

### 5. Pi is first-class with remediation-based completion enforcement

Pi support should proceed as first-class for the clean redesign. Its enforcement profile must be precise and honest:

- hard pre-tool blocking through `tool_call`;
- post-tool observation through `tool_result`;
- completion verification after `agent_end`;
- remediation follow-up messages when completion verification fails;
- `done` preserved across failed verification and cleared on success.

Pi should not claim Claude-equivalent hard Stop blocking until Pi exposes or prove_it discovers a hard synchronous Stop primitive. That limitation should be documented as `completion_verification: remediation_after_agent_end`, not as a broad “experimental” label.

### 6. Use capability profiles, not broad experimental labels

Adapters should declare capability/enforcement profiles. The product should report differences at the capability level instead of broadly labeling adapters experimental.

Example profile language:

- Claude: `pre_tool: hard_block`, `completion_verification: hard_block`.
- Pi: `pre_tool: hard_block`, `post_tool: observe`, `completion_verification: remediation_after_agent_end`.

Support tiers can be reconsidered later if the product needs simpler packaging language. For now, capability profiles are the fastest path to accurate implementation decisions.

### 7. Evidence/proving is core methodology; `/prove` is adapter UX

Core methodology includes evidence-oriented proving: claims should be backed by demonstrated checks, artifacts, or reproduction steps. The evidence loop is:

1. Make a concrete claim.
2. Run the thing.
3. Capture evidence.
4. Try to break the claim.
5. Report honestly.

The literal `/prove` command name is adapter/distribution-specific. Claude, Pi, or future adapters may expose the evidence workflow as a slash command, skill, prompt template, tool, or other native surface. Core owns the methodology and report structure, not slash-command semantics.

### 8. TDD is the default methodology profile, not a core invariant

The shipped/default prove_it experience should be TDD-forward because that is central to the value proposition: help agents work in small verified increments and reduce hallucinated completion claims.

The core engine should still remain general. Core owns:

- completion accountability;
- evidence-backed verification;
- reviewer/task accountability;
- signal lifecycle.

The default profile may supply:

- TDD guidance;
- test-first checks;
- red/green/refactor language;
- test-writing or reviewer tasks.

Non-TDD profiles remain valid.

### 9. Phase is out of scope for the Pi-first MVP

The first clean redesign should not include phase state. Focus the MVP on signals, workflows, tasks, evidence, verification, and Pi adapter behavior.

Phase can be reconsidered later if the default TDD profile needs it. It should not block the Pi-first vertical slice.

### 10. Reviewers use the active harness only

For this redesign scope, reviewer tasks use the same harness that is driving the workflow:

- running under Pi means Pi reviewers;
- running under Claude means Claude reviewers.

Alternative-harness reviewers may be interesting later, but they introduce unnecessary complexity and can blur adapter boundaries. Cross-harness reviewers are out of scope for now.

### 11. Human review is downstream/external

prove_it is not a human approval workflow system. Its job is to make autonomous agent work more trustworthy before a human reviews it.

The core product does not require a human approval gate. A human may later review, merge, reject, or continue the resulting slice through any external process. The Pi Board used during this planning effort is a local development aid and should not influence prove_it core semantics.

### 12. Next implementation target: minimal Pi pre-tool config-guard vertical slice

After policy and issue cleanup, the next real implementation target should be a tiny Pi-first tracer bullet:

> Given a repo with strict `.prove_it/config.json` defining one pre-tool guard, when a Pi `tool_call` attempts to edit `.prove_it/config.json`, prove_it blocks the tool call and reports a concise reason.

This slice should cut through:

- strict `.prove_it` config;
- normalized Pi `tool_call` input;
- minimal workflow engine/effect path;
- Pi adapter block response;
- capability profile;
- shared path extraction;
- fake-Pi tests.

It should not include Stop remediation, reviewers, Claude adapter migration, phase, package distribution, or broad docs.

## Impact on follow-on issues

- Issue #3 should still extract shared methodology, but must not introduce user-only signal mode or phase as MVP requirements.
- Issue #4 should define capability profiles and diagnostics without labeling Pi experimental.
- Issue #5 should be reframed away from Claude-first lifecycle extraction; shared event/effect work should support the Pi pre-tool vertical slice first.
- Issue #8 should validate strict `.prove_it` config only and remove legacy runtime compatibility expectations.
- Issue #9 should become the minimal engine path needed by the Pi pre-tool config-guard slice.
- Issue #10 should eventually cover hard-block vs remediation completion effects, but it is not the next slice.
- Issue #11 should move to Claude fast-follow, after Pi proves the contract.
- Issue #13 should become the early Pi pre-tool config-guard vertical slice.
- Issue #14 should expose Pi-native agent signaling/remediation after the pre-tool slice works, with no phase requirement.
- Issue #16 should document Pi as first-class with explicit capability profile, not experimental.
