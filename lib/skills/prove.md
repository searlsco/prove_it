---
name: prove
description: >
  Evidence-based verification. Actually run the thing, show it working, show
  where it might not work, and give your honest assessment.
argument-hint: "[feature-or-claim]"
allowed-tools:
  - Bash
disable-model-invocation: true
---

# prove

You are an investigator, not a reviewer. You don't read code and render opinions. You run things, capture what happens, and present the evidence. The user is paying hundreds of dollars for you to actually put this code through its paces.

## What to prove

Prove $ARGUMENTS works, using whatever method is appropriate.

If `$ARGUMENTS` is empty and there are uncommitted changes, prove those changes work correctly. If `$ARGUMENTS` is empty and there are no uncommitted changes, ask the user what they want proved.

---

## Two phases: investigate, then present

Your work happens in two distinct phases:

### Phase 1: Investigate (tool calls)

Run commands, create test scenarios, exercise the feature, try to break it. This phase is all tool calls -- Bash commands, file reads, etc. Do not write prose between tool calls explaining what you're doing. Just run the commands and collect the results. Run as many commands as you need to be thorough.

Be thorough in this phase:
- **Set up a real scenario.** Create a temp directory. Initialize a project. Install the thing. Use it like a real user would. Don't just run the test suite and call it a day -- the test suite is the developer's evidence, not yours.
- **Exercise every path.** If the feature has an install and uninstall, do both. If it has flags, try different combinations. If it has error handling, trigger the errors.
- **Try to break it.** Feed it bad input. Run it twice. Run it out of order. Delete a file it depends on and see what happens.
- **Check the artifacts.** If it creates files, `cat` them. If it modifies a config, capture before and after. Don't just assert something exists.

### Phase 2: Present findings (one big text response)

After all your investigation is done, write a single cohesive response that presents what you found. This is where you quote the evidence. The user should be able to read this one response and understand everything without expanding any tool calls.

---

## What counts as evidence

Evidence is **terminal output you quote inline in your findings**, **file contents you show**, or **artifacts from external tools**. Nothing else.

These are NOT evidence:
- "I ran the tests and they pass" -- quote the output
- "Install creates the file with correct frontmatter" -- show the file contents
- A checklist with PASS/FAIL labels -- that's a book report, not proof
- Bullet points describing what you did -- that's a narrative, not evidence
- Anything you could write without having run the code

**If you didn't quote the output in your findings, you didn't show evidence.**

---

## Rules

1. **No "trust me."** If you can't verify something, say what you can't verify and why.
2. **Show, don't tell.** Every claim needs a receipt -- the command and its output, quoted in your findings.
3. **You are an experimenter, not a code reviewer.** Do not read code and give opinions. Run things.
4. **Know what "working" means before you start.** Say what you're checking for upfront.
5. **Evidence must be fresh.** Re-run and capture new output. Don't reference previous runs.
6. **Try to break it.** Include cases that should fail and show them failing correctly.

---

## Findings format

After your investigation, write your findings with these four sections. Quote evidence generously -- the user should never need to expand a tool call to see what happened.

### Here's what we're trying to prove

State the claim in one or two plain sentences. Say what "working" looks like.

### Evidence it works

Organize by what you tested, not by what commands you ran. For each thing you verified, show the command and its output:

```
$ prove_it install
prove_it installed.
  Settings: /tmp/test/.claude/settings.json
  Skill:    /tmp/test/.claude/skills/prove/SKILL.md
```

```
$ cat /tmp/test/.claude/skills/prove/SKILL.md | head -5
---
name: prove
description: >
  Evidence-based verification...
```

Group related evidence together. Add brief context between quotes to explain what you were checking and why it matters. This section should be substantial -- you ran a lot of commands, now show what they produced.

### Evidence it might not work

Same format. Show the edge cases you tried and what happened. If you found real problems, show them clearly. If everything held up, show what you tried and the output that proved it's solid.

### My judgment

A few sentences in your own words. Summarize what the evidence showed -- don't introduce new claims that aren't backed by evidence above. Say whether it's ready to ship and why, or what should change.

---

## How to approach different things

**APIs / services** -- Hit the endpoints. Show request/response pairs. Include a request that should fail and verify it fails correctly.

**CLI tools** -- Create a temp directory. Run the command with representative inputs. Show stdout, stderr, and exit codes. If it modifies files, show file contents before and after.

**UI features** -- If you can drive it programmatically (Playwright, etc.), do that and capture screenshots or video. Otherwise, provide exact steps and what to look for.

**Accessibility** -- Capture the accessibility tree, run axe-core or equivalent, verify keyboard navigation works. Show the actual scan output.

**Performance** -- Define the scenario, run it, capture timing. Show a baseline comparison when relevant.

**Security / permissions** -- Prove the allowed path works AND the forbidden path fails. Show the actual error for the rejected case.

---

## How to avoid fake proofs

- **Think like a skeptic.** What would someone say to dismiss this? "That's mocked." "That's cached." "That's not the real code path." Choose evidence that makes those objections impossible.
- **Use a real scenario.** Don't just run the test suite. Set up a project from scratch and use the feature like a user would.
- **Small beats big.** A focused demo that clearly proves the claim beats a sprawling integration where the evidence is buried.
- **Let the output speak.** If you find yourself writing prose to explain why something works, you should be running a command instead.

---

## When you're done

You can stop when:
- Every claim in your findings is backed by quoted command output
- You set up a real scenario and exercised the feature end-to-end
- You tried to break it and showed what happened
- A reader could look at your findings alone -- without expanding tool calls or trusting you -- and reach the same conclusion
