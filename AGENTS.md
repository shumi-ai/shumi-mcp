# Agent instructions

This is `shumi-ai/shumi-mcp`, the MCP server that exposes Shumi's crypto intelligence tools to MCP clients.

## Priorities

The north star and the bets in flight live in one page: `pxeodev/docs/strategy/current.mdx`. Nothing here copies it. When planning, prioritizing, or triaging, fetch it fresh:

    gh api repos/pxeodev/docs/contents/strategy/current.mdx -H 'Accept: application/vnd.github.raw'

Every PR and issue carries one label: `bet:<slug>` for a bet on that page, or `ktlo` for keep-the-lights-on (the page holds the closed list). Work that fits neither is not started — it needs a PR against that page first. Strategy changes are PRs to that page, merged only when both founders agree in the thread; never merge there yourself.
