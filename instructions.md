# Coding Instructions & Guidelines

Behavioral guidelines to reduce common LLM coding mistakes, tailored for this repository.

---

## 1. Test Before You Commit / Deploy (Critical)

**Always write, execute, and verify a local integration test script in the scratch workspace before staging, committing, or deploying any code.**

Never rely on assumptions. Follow these steps for every change:
1. **Locate or Create a Scratch Test Script**: Write or update a test script inside the scratch directory (e.g., `<appDataDir>/brain/<conversation-id>/scratch/`).
2. **Execute Locally**: Run the test script (using `node` or the appropriate runtime) to verify that the logic functions correctly.
3. **Verify Edge Cases**: Actively test potential error paths, boundary conditions, and malformed inputs.
4. **Compare Outputs**: Confirm that the modified code works correctly on live or mocked inputs before calling the task complete, committing, or running Vercel deployments.

---

## 2. Answer Questions and Summarize Plans Before Implementing (Critical)

**Never jump straight into writing code or executing write/execute tool calls without first answering the user's questions and summarizing your proposed plan.**

Before making any changes:
1. **Answer All Questions Directly**: If the user asks a question, answer it clearly and fully in the chat *first*, before discussing or initiating any changes.
2. **Summarize Your Plan First (Standard Verbosity)**: Present a concise plan explaining:
   * **Target Files**: List of files to be edited.
   * **Proposed Changes**: A bulleted list of logical modifications.
   * **Verification Plan**: How the changes will be tested and verified locally.
3. **Don't Assume / Stop & Ask**: If the user's request is open-ended or multiple interpretations exist, present the options, outline trade-offs, and wait for confirmation. If something is unclear, stop, name what is confusing, and ask.

---

## 3. Simplicity First

**Minimum code that solves the problem. Nothing speculative.**

- No features beyond what was asked.
- No abstractions for single-use code.
- No "flexibility" or "configurability" that wasn't requested.
- No error handling for impossible scenarios.
- If you write 200 lines and it could be 50, rewrite it.

Ask yourself: "Would a senior engineer say this is overcomplicated?" If yes, simplify.

---

## 4. Surgical Changes

**Touch only what you must. Clean up only your own mess.**

When editing existing code:
- Don't "improve" adjacent code, comments, or formatting.
- Don't refactor things that aren't broken.
- Match existing style, even if you'd do it differently.
- If you notice unrelated dead code, mention it - don't delete it.

When your changes create orphans:
- Remove imports/variables/functions that YOUR changes made unused.
- Don't remove pre-existing dead code unless asked.

The test: Every changed line should trace directly to the user's request.

---

## 5. Goal-Driven Execution

**Define success criteria. Loop until verified.**

Transform tasks into verifiable goals:
- "Add validation" → "Write tests for invalid inputs, then make them pass"
- "Fix the bug" → "Write a test that reproduces it, then make it pass"
- "Refactor X" → "Ensure tests pass before and after"

For multi-step tasks, state a brief plan:
```
1. [Step] → verify: [check]
2. [Step] → verify: [check]
3. [Step] → verify: [check]
```

Strong success criteria let you loop independently. Weak criteria ("make it work") require constant clarification.
