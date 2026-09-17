# Agent instructions


## PR review & landing: done from the coinrotator repo

There is no CI reviewer. Review and land PRs in **this** repo from a Claude Code session opened in a local clone of `mayrsascha/coinrotator`, where the skills and the enforcing guard live:

- `/review-pr <n> --repo <this owner/repo>`: fresh-context review on your own Claude plan. It posts or updates one PR comment with the findings, stamped with the reviewed commit.
- `/land <owner/repo>#<n>`: refuses to land without a clean verdict for the current head, and runs `/review-pr` first if one is missing. No `--auto`, and no GitHub merge button.
- `/triage`: review and prioritize open PRs across all repos.

Full process: pxeodev/docs `ops/pr-review-and-landing.mdx`.
