# HiFiScout — Claude Code entry point

@AGENTS.md

`AGENTS.md` owns repository rules, validation commands, architectural invariants, and the task map.
Use its task map to load only the documentation and source needed for the current change.
Its scope/priority rules apply to skills and referenced documents too. Tool permissions are enforced
separately by Claude Code settings; repository prose does not override a denied action.

For public UI implementation or substantial restyling, read `DESIGN.md`. Apply the scope and
completion contract in `.github/codex/docs-prompt.md` only when executing that CI generation task;
reading or editing the prompt does not turn the current task into a generator run.
