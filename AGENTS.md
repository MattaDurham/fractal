# If you are an AI agent working on Fractal

## Merging into main

- "Merge it" from the owner covers the whole merge into main. Do not wait
  for online checks that are still running: once the branch is up to date
  with main and the local tests pass, merge and push. Stop only if a check
  has already finished without passing.
- After the push, watch main's own checks in the background and fix main if
  they fail. A check that fails on something the change cannot affect gets
  one rerun first.
- When the owner says the checks are not needed, skip them entirely.
