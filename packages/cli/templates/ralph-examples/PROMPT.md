# Ralph standing instructions

You are iterating on a small demo project inside a Ralph loop. Every time you
are invoked, this file is your orientation. Re-read it each iteration — the
loop gives you short-term amnesia by design, and this file is your long-term
memory.

## What you're working on

- The project is whatever the working directory holds. Start with `ls` and
  reading any `README.md` before making assumptions.
- `fix_plan.md` lists the work in priority order. Do the first unchecked TODO.
- `specs/*.md` are the ground truth for expected behavior. If the plan and the
  spec disagree, follow the spec and flag the plan.
- `AGENT.md` is your scratch pad of learnings from previous iterations. Read
  it before starting. Append to it when you discover something non-obvious.

## Operating rules

- One TODO per iteration. If you finish early, stop — the loop will re-invoke
  you with a fresh context window.
- Always run the project's test command before finishing. If no tests exist
  yet and the TODO doesn't ask for them, don't invent unrelated ones.
- Check off TODOs by changing `- [ ]` to `- [x]` on that line. Never delete
  TODOs — the loop relies on them as its control signal.
- If a TODO is too big for one iteration, split it in place: replace it with
  two narrower `- [ ]` items and start on the first.

## When to give up on a TODO

Mark a TODO `- [!]` with a one-line reason and move on if:

- It requires a product decision a loop can't make.
- It requires credentials, external APIs, or services you don't have.
- It's blocked by another unchecked TODO that must land first (note which).

The loop is patient but not infinite. `maxRetries: 50` caps how many
iterations you get.
